// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// Package protolazy controls the lazy implementation in the protobuf runtime.
//
// The following logic determines whether lazy decoding is enabled:
//  1. Lazy decoding is enabled by default, unless the environment variable
//     GOPROTODEBUG=nolazy is set.
//  2. If still on, calling protolazy.Disable() turns off lazy decoding.
//  3. If still on, proto.UnmarshalOptions's NoLazyDecoding turns off
//     lazy decoding for this Unmarshal operation only.
package protolazy

import (
	"google.golang.org/protobuf/internal/impl"
)

// Disable disables lazy unmarshaling of opaque messages.
//
// Messages which are still on the OPEN or HYBRID API level (see
// https://protobuf.dev/reference/go/opaque-migration/) are never lazily
// unmarshalled.
//
// Fields must be annotated with [lazy = true] in their .proto file to become
// eligible for lazy unmarshaling.
func Disable() (reenable func()) {
	impl.EnableLazyUnmarshal(false)
	return func() {
		impl.EnableLazyUnmarshal(true)
	}
}
