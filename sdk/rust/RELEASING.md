# Release the Rust SDK

## Prepare the first release

1. Merge the SDK PR after its checks pass. Publication requires separate owner approval.
2. Sign in to [crates.io](https://crates.io) through the maintainer's GitHub account. Verify the account email. This account owns the first release. GitHub organization membership alone does not create a crates.io account.
3. Check `https://crates.io/api/v1/crates/worldmonitor` again. On October 20, 2026, it returned HTTP 404. This does not reserve the name. If another publisher takes the name, stop and choose a reviewed replacement name in the manifest, examples, workflow, and docs.
4. In a clean checkout of the merged commit, run the following commands from `sdk/rust`.

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo package --locked --list
cargo publish --locked --dry-run
```

5. Inspect the package file list. It must contain the source, examples, tests, README, MIT license, and lockfile. It must not contain credentials, desktop assets, or build outputs.
6. Create the `rust-v0.1.0` tag on the verified merged commit and push that tag after release approval. Tags do not publish automatically. For later releases, use the version in `Cargo.toml`.
7. Run the **Publish Rust SDK to crates.io** workflow from `main`, with that tag and `dry_run` set to `true`. Check that verification passes.

## Publish the first version

Trusted publishing requires an existing crate. The first publish uses a temporary personal token. See the [Cargo publishing guide](https://doc.rust-lang.org/cargo/reference/publishing.html) and [Rust's trusted publishing announcement](https://blog.rust-lang.org/2025/07/11/crates-io-development-update-2025-07/).

1. Create a short-lived crates.io token with only the permission needed to publish the new `worldmonitor` crate. Do not add the token to this repository or a GitHub secret.
2. From the verified tagged checkout, run `cargo login` interactively. Do not paste the token into a chat, a shell command argument, or a committed file.
3. After owner approval for publication, run `cargo publish --locked` from `sdk/rust`. The command uploads a public crate version.
4. Run `cargo logout` and revoke the temporary token in crates.io account settings.
5. Add another verified maintainer as a crate owner. Check the owner list. Do not leave the crate dependent on one person's account.

## Configure later releases without a stored token

1. Create the GitHub Actions environment `crates-io`. Restrict it to the `main` branch and configure the repository's release approval policy.
2. Open the crate's crates.io settings. Add a trusted publisher with repository owner `koala73`, repository `worldmonitor`, workflow `publish-rust.yml`, and environment `crates-io`.
3. For the next release, bump `sdk/rust/Cargo.toml`, update `Cargo.lock`, verify the crate, and merge the change.
4. Create and push `rust-vX.Y.Z` on that merged commit. Run the release workflow from `main` with the tag and `dry_run` set to `true`.
5. After owner approval, run it again with `dry_run` set to `false`. It verifies the tag and main ancestry, then publishes the exact verified commit with a short-lived OIDC token. Rerunning an already published version cannot overwrite it. Verify availability before deciding whether a failed upload needs a retry.

## Verify availability and discovery

1. Read the crate page at `https://crates.io/crates/worldmonitor` and the version API at `https://crates.io/api/v1/crates/worldmonitor/0.1.0`. For later releases, replace the version.
2. Verify the product homepage, repository, license, README, keywords, and version. Check the docs.rs build at `https://docs.rs/worldmonitor/0.1.0/worldmonitor/`.
3. Create a temporary Cargo project outside this repository. Run `cargo add worldmonitor@0.1.0` and `cargo add serde_json`. Copy the SDK example and build it. Run `cargo run --example sources` from the SDK checkout to check anonymous live access separately.
4. Once registry installation and docs.rs work, replace the unpublished notes in `docs/sdks.mdx` and `public/sdks.md`. Add the verified crate and docs.rs links to those pages and to `public/llms.txt` and `public/api/llms.txt`. Change the SDK count and zero-dependency claims when Rust joins the published SDK table. The crate README already gives conditional installation instructions for both states.
5. Search crates.io for `worldmonitor`, `osint`, and `geopolitics`. Record search visibility separately from package availability. Check downloads after 7 and 30 days. Registry presence does not prove traffic, citations, or new customers.
