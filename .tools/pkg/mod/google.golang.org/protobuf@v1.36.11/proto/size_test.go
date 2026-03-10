// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package proto_test

import (
	"testing"

	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
)

// Checking if [Size] returns 0 is an easy way to recognize empty messages:
func ExampleSize() {
	var m proto.Message
	if proto.Size(m) == 0 {
		// No fields set (or, in proto3, all fields matching the default);
		// skip processing this message, or return an error, or similar.
	}
}

func TestSizeAnyNonNilButEmpty(t *testing.T) {
	ne := &anypb.Any{
		TypeUrl: "abc",
		Value:   []byte{},
	}

	want := protowire.SizeBytes(len("abc")) + protowire.SizeTag(1 /* TypeUrl */)
	if got := proto.Size(ne); got != want {
		t.Errorf("proto.Size(%v) = %v, want %v", prototext.Format(ne), got, want)
	}
}
