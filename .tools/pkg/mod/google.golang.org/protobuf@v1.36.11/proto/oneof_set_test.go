// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package proto_test

import (
	"testing"

	testhybridpb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_hybrid"
	testopaquepb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_opaque"
)

func TestOpenSetNilReceiver(t *testing.T) {
	var x *testhybridpb.TestAllTypes
	expectPanic(t, func() {
		x.SetOneofUint32(24)
	}, "Setting of oneof member on nil receiver did not panic.")
	expectPanic(t, func() {
		x.ClearOneofUint32()
	}, "Clearing of oneof member on nil receiver did not panic.")
	expectPanic(t, func() {
		x.ClearOneofField()
	}, "Clearing of oneof union on nil receiver did not panic.")
}

func TestOpenSet(t *testing.T) {
	x := &testhybridpb.TestAllTypes{}

	tab := []struct {
		fName string      // Field name (in proto)
		set   func()      // Set the field
		clear func()      // Clear the field
		has   func() bool // Has for the field
	}{
		{
			fName: "oneof_uint32",
			set:   func() { x.SetOneofUint32(47) },
			clear: func() { x.ClearOneofUint32() },
			has:   func() bool { return x.HasOneofUint32() },
		},
		{
			fName: "oneof_nested_message",
			set:   func() { x.SetOneofNestedMessage(&testhybridpb.TestAllTypes_NestedMessage{}) },
			clear: func() { x.ClearOneofNestedMessage() },
			has:   func() bool { return x.HasOneofNestedMessage() },
		},
		{
			fName: "oneof_string",
			set:   func() { x.SetOneofString("test") },
			clear: func() { x.ClearOneofString() },
			has:   func() bool { return x.HasOneofString() },
		},
		{
			fName: "oneof_bytes",
			set:   func() { x.SetOneofBytes([]byte("test")) },
			clear: func() { x.ClearOneofBytes() },
			has:   func() bool { return x.HasOneofBytes() },
		},
		{
			fName: "oneof_bool",
			set:   func() { x.SetOneofBool(true) },
			clear: func() { x.ClearOneofBool() },
			has:   func() bool { return x.HasOneofBool() },
		},
		{
			fName: "oneof_uint64",
			set:   func() { x.SetOneofUint64(7438109473104) },
			clear: func() { x.ClearOneofUint64() },
			has:   func() bool { return x.HasOneofUint64() },
		},
		{
			fName: "oneof_float",
			set:   func() { x.SetOneofFloat(3.1415) },
			clear: func() { x.ClearOneofFloat() },
			has:   func() bool { return x.HasOneofFloat() },
		},
		{
			fName: "oneof_double",
			set:   func() { x.SetOneofDouble(3e+8) },
			clear: func() { x.ClearOneofDouble() },
			has:   func() bool { return x.HasOneofDouble() },
		},
		{
			fName: "oneof_enum",
			set:   func() { x.SetOneofEnum(testhybridpb.TestAllTypes_BAZ) },
			clear: func() { x.ClearOneofEnum() },
			has:   func() bool { return x.HasOneofEnum() },
		},
	}

	for i, mv := range tab {
		x.ClearOneofField()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v", got, want)
		}
		mv.set()

		if got, want := x.HasOneofField(), true; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.has(), true; got != want {
			t.Errorf("Has on oneof member returned %v, expected %v (%s)", got, want, mv.fName)
		}

		mv.clear()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.has(), false; got != want {
			t.Errorf("Has on oneof member returned %v, expected %v (%s)", got, want, mv.fName)
		}
		other := tab[(i+1)%len(tab)]
		mv.set()
		other.set()

		if got, want := x.HasOneofField(), true; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.has(), false; got != want {
			t.Errorf("Has on oneof member returned %v, expected %v (%s)", got, want, mv.fName)
		}
		other.clear()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
	}
	x.SetOneofUint32(47)
	if got, want := x.HasOneofField(), true; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofUint32(), true; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	x.SetOneofNestedMessage(nil)
	if got, want := x.HasOneofField(), false; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofUint32(), false; got != want {
		t.Errorf("HasOneofUint32 returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofNestedMessage(), false; got != want {
		t.Errorf("HasOneofNestedMessage returned %v, expected %v", got, want)
	}
	x.SetOneofUint32(47)
	if got, want := x.HasOneofField(), true; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofUint32(), true; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	x.SetOneofBytes(nil)
	if got, want := x.HasOneofField(), true; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofUint32(), false; got != want {
		t.Errorf("HasOneofUint32 returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofBytes(), true; got != want {
		t.Errorf("HasOneofNestedMessage returned %v, expected %v", got, want)
	}
}

func TestOpaqueSetNilReceiver(t *testing.T) {
	var x *testopaquepb.TestAllTypes
	expectPanic(t, func() {
		x.SetOneofUint32(24)
	}, "Setting of oneof member on nil receiver did not panic.")
	expectPanic(t, func() {
		x.ClearOneofUint32()
	}, "Clearing of oneof member on nil receiver did not panic.")
	expectPanic(t, func() {
		x.ClearOneofField()
	}, "Clearing of oneof union on nil receiver did not panic.")
}

func TestOpaqueSet(t *testing.T) {
	x := &testopaquepb.TestAllTypes{}

	tab := []struct {
		fName string      // Field name (in proto)
		set   func()      // Set the field
		clear func()      // Clear the field
		has   func() bool // Has for the field
	}{
		{
			fName: "oneof_uint32",
			set:   func() { x.SetOneofUint32(47) },
			clear: func() { x.ClearOneofUint32() },
			has:   func() bool { return x.HasOneofUint32() },
		},
		{
			fName: "oneof_nested_message",
			set:   func() { x.SetOneofNestedMessage(&testopaquepb.TestAllTypes_NestedMessage{}) },
			clear: func() { x.ClearOneofNestedMessage() },
			has:   func() bool { return x.HasOneofNestedMessage() },
		},
		{
			fName: "oneof_string",
			set:   func() { x.SetOneofString("test") },
			clear: func() { x.ClearOneofString() },
			has:   func() bool { return x.HasOneofString() },
		},
		{
			fName: "oneof_bytes",
			set:   func() { x.SetOneofBytes([]byte("test")) },
			clear: func() { x.ClearOneofBytes() },
			has:   func() bool { return x.HasOneofBytes() },
		},
		{
			fName: "oneof_bool",
			set:   func() { x.SetOneofBool(true) },
			clear: func() { x.ClearOneofBool() },
			has:   func() bool { return x.HasOneofBool() },
		},
		{
			fName: "oneof_uint64",
			set:   func() { x.SetOneofUint64(7438109473104) },
			clear: func() { x.ClearOneofUint64() },
			has:   func() bool { return x.HasOneofUint64() },
		},
		{
			fName: "oneof_float",
			set:   func() { x.SetOneofFloat(3.1415) },
			clear: func() { x.ClearOneofFloat() },
			has:   func() bool { return x.HasOneofFloat() },
		},
		{
			fName: "oneof_double",
			set:   func() { x.SetOneofDouble(3e+8) },
			clear: func() { x.ClearOneofDouble() },
			has:   func() bool { return x.HasOneofDouble() },
		},
		{
			fName: "oneof_enum",
			set:   func() { x.SetOneofEnum(testopaquepb.TestAllTypes_BAZ) },
			clear: func() { x.ClearOneofEnum() },
			has:   func() bool { return x.HasOneofEnum() },
		},
	}

	for i, mv := range tab {
		x.ClearOneofField()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v", got, want)
		}
		mv.set()

		if got, want := x.HasOneofField(), true; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.has(), true; got != want {
			t.Errorf("Has on oneof member returned %v, expected %v (%s)", got, want, mv.fName)
		}

		mv.clear()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.has(), false; got != want {
			t.Errorf("Has on oneof member returned %v, expected %v (%s)", got, want, mv.fName)
		}
		other := tab[(i+1)%len(tab)]
		mv.set()
		other.set()

		if got, want := x.HasOneofField(), true; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.has(), false; got != want {
			t.Errorf("Has on oneof member returned %v, expected %v (%s)", got, want, mv.fName)
		}
		other.clear()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
	}
	x.SetOneofUint32(47)
	if got, want := x.HasOneofField(), true; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofUint32(), true; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	x.SetOneofNestedMessage(nil)
	if got, want := x.HasOneofField(), false; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofUint32(), false; got != want {
		t.Errorf("HasOneofUint32 returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofNestedMessage(), false; got != want {
		t.Errorf("HasOneofNestedMessage returned %v, expected %v", got, want)
	}
	x.SetOneofUint32(47)
	if got, want := x.HasOneofField(), true; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofUint32(), true; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	x.SetOneofBytes(nil)
	if got, want := x.HasOneofField(), true; got != want {
		t.Errorf("HasOneofField returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofUint32(), false; got != want {
		t.Errorf("HasOneofUint32 returned %v, expected %v", got, want)
	}
	if got, want := x.HasOneofBytes(), true; got != want {
		t.Errorf("HasOneofNestedMessage returned %v, expected %v", got, want)
	}
}
