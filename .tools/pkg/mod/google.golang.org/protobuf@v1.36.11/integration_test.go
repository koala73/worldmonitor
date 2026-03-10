// Copyright 2019 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/internal/version"
)

var (
	regenerate   = flag.Bool("regenerate", false, "regenerate files")
	buildRelease = flag.Bool("buildRelease", false, "build release binaries")

	protobufVersion = "33.2"

	golangVersions = func() []string {
		// Version policy: oldest supported version of Go, plus the version before that.
		// This matches the version policy of the Google Cloud Client Libraries:
		// https://cloud.google.com/go/getting-started/supported-go-versions
		return []string{
			"1.23.12",
			"1.24.6",
			"1.25.0",
		}
	}()
	golangLatest = golangVersions[len(golangVersions)-1]

	staticcheckVersion = "2025.1"
	staticcheckSHA256s = map[string]string{
		"darwin/amd64": "b9c82a0bdcf0bd7b5c46524d7e58323f17998b2e15ecacba608ac21be9fa345d",
		"darwin/arm64": "1fc58b389de90e1e220fd23489dc685fc3e6435266f3c20c914f56a98f99844c",
		"linux/386":    "58f7e465f7c15f70cea0b940e530826031d414b37ebdd40b073b2ca215171b42",
		"linux/amd64":  "b0f4a46bab253bda0d9e874abcd988453c95f3ed849e617c34123c37c11a0604",
	}

	// purgeTimeout determines the maximum age of unused sub-directories.
	purgeTimeout = 30 * 24 * time.Hour // 1 month

	// Variables initialized by mustInitDeps.
	modulePath   string
	protobufPath string
)

func TestIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	if os.Getenv("GO_BUILDER_NAME") != "" {
		// To start off, run on longtest builders, not longtest-race ones.
		if race() {
			t.Skip("skipping integration test in race mode on builders")
		}
		// When on a builder, run even if it's not explicitly requested
		// provided our caller isn't already running it.
		if os.Getenv("GO_PROTOBUF_INTEGRATION_TEST_RUNNING") == "1" {
			t.Skip("protobuf integration test is already running, skipping nested invocation")
		}
		os.Setenv("GO_PROTOBUF_INTEGRATION_TEST_RUNNING", "1")
	} else if flag.Lookup("test.run").Value.String() != "^TestIntegration$" {
		t.Skip("not running integration test if not explicitly requested via test.bash")
	}

	mustInitDeps(t)
	mustHandleFlags(t)

	// Report dirt in the working tree quickly, rather than after
	// going through all the presubmits.
	//
	// Fail the test late, so we can test uncommitted changes with -failfast.
	gitDiff := mustRunCommand(t, "git", "diff", "HEAD")
	if strings.TrimSpace(gitDiff) != "" {
		fmt.Printf("WARNING: working tree contains uncommitted changes:\n%v\n", gitDiff)
	}
	gitUntracked := mustRunCommand(t, "git", "ls-files", "--others", "--exclude-standard")
	if strings.TrimSpace(gitUntracked) != "" {
		fmt.Printf("WARNING: working tree contains untracked files:\n%v\n", gitUntracked)
	}

	// Do the relatively fast checks up-front.
	t.Run("GeneratedGoFiles", func(t *testing.T) {
		diff := mustRunCommand(t, "go", "run", "-tags", "protolegacy", "./internal/cmd/generate-types")
		if strings.TrimSpace(diff) != "" {
			t.Fatalf("stale generated files:\n%v", diff)
		}
		diff = mustRunCommand(t, "go", "run", "-tags", "protolegacy", "./internal/cmd/generate-protos")
		if strings.TrimSpace(diff) != "" {
			t.Fatalf("stale generated files:\n%v", diff)
		}
	})
	t.Run("FormattedGoFiles", func(t *testing.T) {
		files := strings.Split(strings.TrimSpace(mustRunCommand(t, "git", "ls-files", "*.go")), "\n")
		diff := mustRunCommand(t, append([]string{"gofmt", "-d"}, files...)...)
		if strings.TrimSpace(diff) != "" {
			t.Fatalf("unformatted source files:\n%v", diff)
		}
	})
	t.Run("GeneratedVet", func(t *testing.T) {
		files := strings.Split(strings.TrimSpace(mustRunCommand(t, "go", "list", "./internal/testprotos/...")), "\n")
		filtered := make([]string, 0, len(files))
		for _, f := range files {
			if strings.Contains(f, "/legacy/") {
				continue
			}
			filtered = append(filtered, f)
		}
		mustRunCommand(t, append([]string{"go", "vet"}, filtered...)...)
	})
	t.Run("CopyrightHeaders", func(t *testing.T) {
		files := strings.Split(strings.TrimSpace(mustRunCommand(t, "git", "ls-files", "*.go", "*.proto")), "\n")
		mustHaveCopyrightHeader(t, files)
	})

	var wg sync.WaitGroup
	sema := make(chan bool, (runtime.NumCPU()+1)/2)
	for i := range golangVersions {
		goVersion := golangVersions[i]
		goLabel := "Go" + goVersion
		runGo := func(label string, cmd command, args ...string) {
			wg.Add(1)
			sema <- true
			go func() {
				defer wg.Done()
				defer func() { <-sema }()
				t.Run(goLabel+"/"+label, func(t *testing.T) {
					args[0] += goVersion
					cmd.mustRun(t, args...)
				})
			}()
		}

		runGo("Normal", command{}, "go", "test", "-race", "./...")
		runGo("LazyDecoding", command{}, "go", "test", "./proto", "-test_lazy_unmarshal")
		runGo("Reflect", command{}, "go", "test", "-race", "-tags", "protoreflect", "./...")
		if goVersion == golangLatest {
			runGo("ProtoLegacyRace", command{}, "go", "test", "-race", "-tags", "protolegacy", "./...")
			runGo("ProtoLegacy", command{}, "go", "test", "-tags", "protolegacy", "./...")
			runGo("ProtocGenGo", command{Dir: "cmd/protoc-gen-go/testdata"}, "go", "test")
			runGo("Conformance", command{Dir: "internal/conformance"}, "go", "test", "-tags", "protolegacy", "-execute")

			// Only run the 32-bit compatibility tests for Linux;
			// avoid Darwin since 10.15 dropped support i386 code execution.
			if runtime.GOOS == "linux" {
				runGo("Arch32Bit", command{Env: append(os.Environ(), "GOARCH=386")}, "go", "test", "./...")
			}
		}
	}
	wg.Wait()

	t.Run("GoStaticCheck", func(t *testing.T) {
		checks := []string{
			"all",     // start with all checks enabled
			"-SA1019", // disable deprecated usage check
			"-S*",     // disable code simplification checks
			"-ST*",    // disable coding style checks
			"-U*",     // disable unused declaration checks
		}
		out := mustRunCommand(t, "staticcheck", "-checks="+strings.Join(checks, ","), "-fail=none", "./...")

		// Filter out findings from certain paths.
		var findings []string
		for _, finding := range strings.Split(strings.TrimSpace(out), "\n") {
			switch {
			case strings.HasPrefix(finding, "internal/testprotos/legacy/"):
			default:
				findings = append(findings, finding)
			}
		}
		if len(findings) > 0 {
			t.Fatalf("staticcheck findings:\n%v", strings.Join(findings, "\n"))
		}
	})
	t.Run("CommittedGitChanges", func(t *testing.T) {
		if strings.TrimSpace(gitDiff) != "" {
			t.Fatalf("uncommitted changes")
		}
	})
	t.Run("TrackedGitFiles", func(t *testing.T) {
		if strings.TrimSpace(gitUntracked) != "" {
			t.Fatalf("untracked files")
		}
	})
}

func mustInitDeps(t *testing.T) {
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}

	// Determine the directory to place the test directory.
	repoRoot, err := os.Getwd()
	check(err)
	testDir := filepath.Join(repoRoot, ".cache")
	check(os.MkdirAll(testDir, 0775))

	// Delete the current directory if non-empty,
	// which only occurs if a dependency failed to initialize properly.
	var workingDir string
	finishedDirs := map[string]bool{}
	defer func() {
		if workingDir != "" {
			os.RemoveAll(workingDir) // best-effort
		}
	}()
	startWork := func(name string) string {
		workingDir = filepath.Join(testDir, name)
		return workingDir
	}
	finishWork := func() {
		finishedDirs[workingDir] = true
		workingDir = ""
	}

	// Delete other sub-directories that are no longer relevant.
	defer func() {
		now := time.Now()
		fis, _ := os.ReadDir(testDir)
		for _, fi := range fis {
			dir := filepath.Join(testDir, fi.Name())
			if finishedDirs[dir] {
				os.Chtimes(dir, now, now) // best-effort
				continue
			}
			fii, err := fi.Info()
			check(err)
			if now.Sub(fii.ModTime()) < purgeTimeout {
				continue
			}
			fmt.Printf("delete %v\n", fi.Name())
			os.RemoveAll(dir) // best-effort
		}
	}()

	// The bin directory contains symlinks to each tool by version.
	// It is safe to delete this directory and run the test script from scratch.
	binPath := startWork("bin")
	check(os.RemoveAll(binPath))
	check(os.Mkdir(binPath, 0775))
	check(os.Setenv("PATH", binPath+":"+os.Getenv("PATH")))
	registerBinary := func(name, path string) {
		check(os.Symlink(path, filepath.Join(binPath, name)))
	}
	finishWork()

	// Get the protobuf toolchain.
	protobufPath = startWork("protobuf-" + protobufVersion)
	if _, err := os.Stat(protobufPath); err != nil {
		fmt.Printf("download %v\n", filepath.Base(protobufPath))
		checkoutVersion := protobufVersion
		if isCommit := strings.Trim(protobufVersion, "0123456789abcdef") == ""; !isCommit {
			// release tags have "v" prefix
			checkoutVersion = "v" + protobufVersion
		}
		command{Dir: testDir}.mustRun(t, "git", "clone", "https://github.com/protocolbuffers/protobuf", "protobuf-"+protobufVersion)
		command{Dir: protobufPath}.mustRun(t, "git", "checkout", checkoutVersion)

		if os.Getenv("GO_BUILDER_NAME") != "" {
			// If this is running on the Go build infrastructure,
			// use pre-built versions of these binaries that the
			// builders are configured to provide in $PATH.
			protocPath, err := exec.LookPath("protoc")
			check(err)
			confTestRunnerPath, err := exec.LookPath("conformance_test_runner")
			check(err)
			check(os.MkdirAll(filepath.Join(protobufPath, "bazel-bin", "conformance"), 0775))
			check(os.Symlink(protocPath, filepath.Join(protobufPath, "bazel-bin", "protoc")))
			check(os.Symlink(confTestRunnerPath, filepath.Join(protobufPath, "bazel-bin", "conformance", "conformance_test_runner")))
		} else {
			// In other environments, download and build the protobuf toolchain.
			// We avoid downloading the pre-compiled binaries since they do not contain
			// the conformance test runner.
			fmt.Printf("build %v\n", filepath.Base(protobufPath))
			env := os.Environ()
			args := []string{
				"bazel", "build",
				":protoc",
				"//conformance:conformance_test_runner",
			}
			if runtime.GOOS == "darwin" {
				// Adding this environment variable appears to be necessary for macOS builds.
				env = append(env, "CC=clang")
				// And this flag.
				args = append(args,
					"--macos_minimum_os=13.0",
					"--host_macos_minimum_os=13.0",
				)
			}
			command{
				Dir: protobufPath,
				Env: env,
			}.mustRun(t, args...)
		}
	}
	check(os.Setenv("PROTOBUF_ROOT", protobufPath)) // for generate-protos
	registerBinary("conform-test-runner", filepath.Join(protobufPath, "bazel-bin", "conformance", "conformance_test_runner"))
	registerBinary("protoc", filepath.Join(protobufPath, "bazel-bin", "protoc"))
	finishWork()

	// Download each Go toolchain version.
	for _, v := range golangVersions {
		goDir := startWork("go" + v)
		if _, err := os.Stat(goDir); err != nil {
			fmt.Printf("download %v\n", filepath.Base(goDir))
			url := fmt.Sprintf("https://dl.google.com/go/go%v.%v-%v.tar.gz", v, runtime.GOOS, runtime.GOARCH)
			downloadArchive(check, goDir, url, "go", "") // skip SHA256 check as we fetch over https from a trusted domain
		}
		registerBinary("go"+v, filepath.Join(goDir, "bin", "go"))
		finishWork()
	}
	registerBinary("go", filepath.Join(testDir, "go"+golangLatest, "bin", "go"))
	registerBinary("gofmt", filepath.Join(testDir, "go"+golangLatest, "bin", "gofmt"))

	// Download the staticcheck tool.
	checkDir := startWork("staticcheck-" + staticcheckVersion)
	if _, err := os.Stat(checkDir); err != nil {
		fmt.Printf("download %v\n", filepath.Base(checkDir))
		url := fmt.Sprintf("https://github.com/dominikh/go-tools/releases/download/%v/staticcheck_%v_%v.tar.gz", staticcheckVersion, runtime.GOOS, runtime.GOARCH)
		downloadArchive(check, checkDir, url, "staticcheck", staticcheckSHA256s[runtime.GOOS+"/"+runtime.GOARCH])
	}
	registerBinary("staticcheck", filepath.Join(checkDir, "staticcheck"))
	finishWork()

	// GitHub actions sets GOROOT, which confuses invocations of the Go toolchain.
	// Explicitly clear GOROOT, so each toolchain uses their default GOROOT.
	check(os.Unsetenv("GOROOT"))

	// Set a cache directory outside the test directory.
	check(os.Setenv("GOCACHE", filepath.Join(repoRoot, ".gocache")))
}

func downloadFile(check func(error), dstPath, srcURL string, perm fs.FileMode) {
	resp, err := http.Get(srcURL)
	check(err)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		check(fmt.Errorf("GET %q: non-200 OK status code: %v body: %q", srcURL, resp.Status, body))
	}

	check(os.MkdirAll(filepath.Dir(dstPath), 0775))
	f, err := os.OpenFile(dstPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	check(err)

	_, err = io.Copy(f, resp.Body)
	check(err)

	check(f.Close())
}

func downloadArchive(check func(error), dstPath, srcURL, skipPrefix, wantSHA256 string) {
	check(os.RemoveAll(dstPath))

	resp, err := http.Get(srcURL)
	check(err)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		check(fmt.Errorf("GET %q: non-200 OK status code: %v body: %q", srcURL, resp.Status, body))
	}

	var r io.Reader = resp.Body
	if wantSHA256 != "" {
		b, err := io.ReadAll(resp.Body)
		check(err)
		r = bytes.NewReader(b)

		if gotSHA256 := fmt.Sprintf("%x", sha256.Sum256(b)); gotSHA256 != wantSHA256 {
			check(fmt.Errorf("checksum validation error:\ngot  %v\nwant %v", gotSHA256, wantSHA256))
		}
	}

	zr, err := gzip.NewReader(r)
	check(err)

	tr := tar.NewReader(zr)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return
		}
		check(err)

		// Skip directories or files outside the prefix directory.
		if len(skipPrefix) > 0 {
			if !strings.HasPrefix(h.Name, skipPrefix) {
				continue
			}
			if len(h.Name) > len(skipPrefix) && h.Name[len(skipPrefix)] != '/' {
				continue
			}
		}

		path := strings.TrimPrefix(strings.TrimPrefix(h.Name, skipPrefix), "/")
		path = filepath.Join(dstPath, filepath.FromSlash(path))
		mode := os.FileMode(h.Mode & 0777)
		switch h.Typeflag {
		case tar.TypeReg:
			b, err := io.ReadAll(tr)
			check(err)
			check(os.WriteFile(path, b, mode))
		case tar.TypeDir:
			check(os.Mkdir(path, mode))
		}
	}
}

func mustHandleFlags(t *testing.T) {
	if *regenerate {
		t.Run("Generate", func(t *testing.T) {
			fmt.Print(mustRunCommand(t, "go", "generate", "./internal/cmd/generate-types"))
			fmt.Print(mustRunCommand(t, "go", "generate", "./internal/cmd/generate-protos"))
			files := strings.Split(strings.TrimSpace(mustRunCommand(t, "git", "ls-files", "*.go")), "\n")
			mustRunCommand(t, append([]string{"gofmt", "-w"}, files...)...)
		})
	}
	if *buildRelease {
		t.Run("BuildRelease", func(t *testing.T) {
			v := version.String()
			for _, goos := range []string{"linux", "darwin", "windows"} {
				for _, goarch := range []string{"386", "amd64", "arm64"} {
					// Avoid Darwin since 10.15 dropped support for i386.
					if goos == "darwin" && goarch == "386" {
						continue
					}

					binPath := filepath.Join("bin", fmt.Sprintf("protoc-gen-go.%v.%v.%v", v, goos, goarch))

					// Build the binary.
					cmd := command{Env: append(os.Environ(), "GOOS="+goos, "GOARCH="+goarch)}
					cmd.mustRun(t, "go", "build", "-trimpath", "-ldflags", "-s -w -buildid=", "-o", binPath, "./cmd/protoc-gen-go")

					// Archive and compress the binary.
					in, err := os.ReadFile(binPath)
					if err != nil {
						t.Fatal(err)
					}
					out := new(bytes.Buffer)
					suffix := ""
					comment := fmt.Sprintf("protoc-gen-go VERSION=%v GOOS=%v GOARCH=%v", v, goos, goarch)
					switch goos {
					case "windows":
						suffix = ".zip"
						zw := zip.NewWriter(out)
						zw.SetComment(comment)
						fw, _ := zw.Create("protoc-gen-go.exe")
						fw.Write(in)
						zw.Close()
					default:
						suffix = ".tar.gz"
						gz, _ := gzip.NewWriterLevel(out, gzip.BestCompression)
						gz.Comment = comment
						tw := tar.NewWriter(gz)
						tw.WriteHeader(&tar.Header{
							Name: "protoc-gen-go",
							Mode: int64(0775),
							Size: int64(len(in)),
						})
						tw.Write(in)
						tw.Close()
						gz.Close()
					}
					if err := os.WriteFile(binPath+suffix, out.Bytes(), 0664); err != nil {
						t.Fatal(err)
					}
				}
			}
		})
	}
	if *regenerate || *buildRelease {
		t.SkipNow()
	}
}

var copyrightRegex = []*regexp.Regexp{
	regexp.MustCompile(`^// Copyright \d\d\d\d The Go Authors\. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file\.
`),
	// Generated .pb.go files from main protobuf repo.
	regexp.MustCompile(`^// Protocol Buffers - Google's data interchange format
// Copyright \d\d\d\d Google Inc\.  All rights reserved\.
`),
}

func mustHaveCopyrightHeader(t *testing.T, files []string) {
	var bad []string
File:
	for _, file := range files {
		if strings.HasSuffix(file, "internal/testprotos/conformance/editions/test_messages_edition2023.pb.go") {
			// TODO(lassefolger) the underlying proto file is checked into
			// the protobuf repo without a copyright header. Fix is pending but
			// might require a release.
			continue
		}
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		// Files like test_messages_proto2_editions.pb.go start with a
		// clang-format directive that has to go before the copyright header for
		// technical reasons.
		b = bytes.TrimPrefix(b, []byte("// clang-format off\n"))
		for _, re := range copyrightRegex {
			if loc := re.FindIndex(b); loc != nil && loc[0] == 0 {
				continue File
			}
		}
		bad = append(bad, file)
	}
	if len(bad) > 0 {
		t.Fatalf("files with missing/bad copyright headers:\n  %v", strings.Join(bad, "\n  "))
	}
}

type command struct {
	Dir string
	Env []string
}

func (c command) mustRun(t *testing.T, args ...string) string {
	t.Helper()
	stdout := new(bytes.Buffer)
	stderr := new(bytes.Buffer)
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = "."
	if c.Dir != "" {
		cmd.Dir = c.Dir
	}
	cmd.Env = os.Environ()
	if c.Env != nil {
		cmd.Env = c.Env
	}
	cmd.Env = append(cmd.Env, "PWD="+cmd.Dir)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("executing (%v): %v\n%s%s", strings.Join(args, " "), err, stdout.String(), stderr.String())
	}
	return stdout.String()
}

func mustRunCommand(t *testing.T, args ...string) string {
	t.Helper()
	return command{}.mustRun(t, args...)
}

// race is an approximation of whether the race detector is on.
// It's used to skip the integration test on builders, without
// preventing the integration test from running under the race
// detector as a '//go:build !race' build constraint would.
func race() bool {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return false
	}
	for _, setting := range bi.Settings {
		if setting.Key == "-race" {
			return setting.Value == "true"
		}
	}
	return false
}
