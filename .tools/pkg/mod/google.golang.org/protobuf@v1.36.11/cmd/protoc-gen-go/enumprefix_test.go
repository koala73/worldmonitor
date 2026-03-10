// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package main

import (
	"testing"

	"google.golang.org/protobuf/cmd/protoc-gen-go/testdata/enumprefix"
)

func TestStripEnumPrefix(t *testing.T) {
	// The file default for enumprefix.proto is to strip prefixes:
	_ = enumprefix.Strip_ZERO

	// The enum Both should generate both names:
	_ = enumprefix.Both_ZERO
	_ = enumprefix.Both_BOTH_ZERO

	// The enum BothNoPrefix is configured to generate both names, but there is
	// no prefix to be stripped, so only an unmodified name is generated.
	_ = enumprefix.BothNoPrefix_ZERO

	// The enum BothButOne is configured to generate both names, except for the
	// ONE value, where only the prefixed name is generated.
	_ = enumprefix.BothButOne_ZERO
	_ = enumprefix.BothButOne_BOTH_BUT_ONE_ONE
}
