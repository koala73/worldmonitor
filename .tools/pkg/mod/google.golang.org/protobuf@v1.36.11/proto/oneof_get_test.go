// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package proto_test

import (
	"testing"

	testhybridpb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_hybrid"
	testopaquepb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_opaque"
)

func expectPanic(t *testing.T, f func(), fmt string, a ...any) {
	t.Helper()
	defer func() {
		t.Helper()
		if r := recover(); r == nil {
			t.Errorf(fmt, a...)
		}
	}()
	f()
}

func TestOpenGet(t *testing.T) {
	x := &testhybridpb.TestAllTypes{}

	tab := []struct {
		fName  string      // Field name (in proto)
		set    func()      // Set the field
		clear  func()      // Clear the field
		has    func() bool // Has for the field
		isZero func() bool // Get and return true if zero value
	}{
		{
			fName:  "oneof_uint32",
			set:    func() { x.SetOneofUint32(47) },
			clear:  func() { x.ClearOneofUint32() },
			has:    func() bool { return x.HasOneofUint32() },
			isZero: func() bool { return x.GetOneofUint32() == 0 },
		},
		{
			fName:  "oneof_nested_message",
			set:    func() { x.SetOneofNestedMessage(&testhybridpb.TestAllTypes_NestedMessage{}) },
			clear:  func() { x.ClearOneofNestedMessage() },
			has:    func() bool { return x.HasOneofNestedMessage() },
			isZero: func() bool { return x.GetOneofNestedMessage() == nil },
		},
		{
			fName:  "oneof_string",
			set:    func() { x.SetOneofString("test") },
			clear:  func() { x.ClearOneofString() },
			has:    func() bool { return x.HasOneofString() },
			isZero: func() bool { return x.GetOneofString() == "" },
		},
		{
			fName:  "oneof_bytes",
			set:    func() { x.SetOneofBytes([]byte("test")) },
			clear:  func() { x.ClearOneofBytes() },
			has:    func() bool { return x.HasOneofBytes() },
			isZero: func() bool { return len(x.GetOneofBytes()) == 0 },
		},
		{
			fName:  "oneof_bool",
			set:    func() { x.SetOneofBool(true) },
			clear:  func() { x.ClearOneofBool() },
			has:    func() bool { return x.HasOneofBool() },
			isZero: func() bool { return x.GetOneofBool() == false },
		},
		{
			fName:  "oneof_uint64",
			set:    func() { x.SetOneofUint64(7438109473104) },
			clear:  func() { x.ClearOneofUint64() },
			has:    func() bool { return x.HasOneofUint64() },
			isZero: func() bool { return x.GetOneofUint64() == 0 },
		},
		{
			fName:  "oneof_float",
			set:    func() { x.SetOneofFloat(3.1415) },
			clear:  func() { x.ClearOneofFloat() },
			has:    func() bool { return x.HasOneofFloat() },
			isZero: func() bool { return x.GetOneofFloat() == 0.0 },
		},
		{
			fName:  "oneof_double",
			set:    func() { x.SetOneofDouble(3e+8) },
			clear:  func() { x.ClearOneofDouble() },
			has:    func() bool { return x.HasOneofDouble() },
			isZero: func() bool { return x.GetOneofDouble() == 0.0 },
		},
		{
			fName:  "oneof_enum",
			set:    func() { x.SetOneofEnum(testhybridpb.TestAllTypes_BAZ) },
			clear:  func() { x.ClearOneofEnum() },
			has:    func() bool { return x.HasOneofEnum() },
			isZero: func() bool { return x.GetOneofEnum() == 0 },
		},
	}

	for i, mv := range tab {
		x.ClearOneofField()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v", got, want)
		}
		if got, want := mv.isZero(), true; got != want {
			t.Errorf("Get on empty oneof member did not return zero value, got %v, expected %v (%s)", got, want, mv.fName)
		}
		mv.set()

		if got, want := x.HasOneofField(), true; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.isZero(), false; got != want {
			t.Errorf("Get on non-empty oneof member did return zero value, got %v, expected %v (%s)", got, want, mv.fName)
		}

		mv.clear()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.isZero(), true; got != want {
			t.Errorf("Get on empty oneof member did not return zero value, got %v, expected %v (%s)", got, want, mv.fName)
		}
		other := tab[(i+1)%len(tab)]
		mv.set()
		other.set()

		if got, want := x.HasOneofField(), true; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.isZero(), true; got != want {
			t.Errorf("Get on wrong oneof member did not return zero value, got %v, expected %v (%s)", got, want, mv.fName)
		}
		other.clear()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
	}
	x = nil
	for _, mv := range tab {
		if got, want := mv.isZero(), true; got != want {
			t.Errorf("Get on nil receiver did not return zero value, got %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.has(), false; got != want {
			t.Errorf("Has on nil receiver failed, got %v, expected %v (%s)", got, want, mv.fName)
		}
	}
}

func TestOpaqueGet(t *testing.T) {
	x := &testopaquepb.TestAllTypes{}

	tab := []struct {
		fName  string      // Field name (in proto)
		set    func()      // Set the field
		clear  func()      // Clear the field
		has    func() bool // Has for the field
		isZero func() bool // Get and return true if zero value
	}{
		{
			fName:  "oneof_uint32",
			set:    func() { x.SetOneofUint32(47) },
			clear:  func() { x.ClearOneofUint32() },
			has:    func() bool { return x.HasOneofUint32() },
			isZero: func() bool { return x.GetOneofUint32() == 0 },
		},
		{
			fName:  "oneof_nested_message",
			set:    func() { x.SetOneofNestedMessage(&testopaquepb.TestAllTypes_NestedMessage{}) },
			clear:  func() { x.ClearOneofNestedMessage() },
			has:    func() bool { return x.HasOneofNestedMessage() },
			isZero: func() bool { return x.GetOneofNestedMessage() == nil },
		},
		{
			fName:  "oneof_string",
			set:    func() { x.SetOneofString("test") },
			clear:  func() { x.ClearOneofString() },
			has:    func() bool { return x.HasOneofString() },
			isZero: func() bool { return x.GetOneofString() == "" },
		},
		{
			fName:  "oneof_bytes",
			set:    func() { x.SetOneofBytes([]byte("test")) },
			clear:  func() { x.ClearOneofBytes() },
			has:    func() bool { return x.HasOneofBytes() },
			isZero: func() bool { return len(x.GetOneofBytes()) == 0 },
		},
		{
			fName:  "oneof_bool",
			set:    func() { x.SetOneofBool(true) },
			clear:  func() { x.ClearOneofBool() },
			has:    func() bool { return x.HasOneofBool() },
			isZero: func() bool { return x.GetOneofBool() == false },
		},
		{
			fName:  "oneof_uint64",
			set:    func() { x.SetOneofUint64(7438109473104) },
			clear:  func() { x.ClearOneofUint64() },
			has:    func() bool { return x.HasOneofUint64() },
			isZero: func() bool { return x.GetOneofUint64() == 0 },
		},
		{
			fName:  "oneof_float",
			set:    func() { x.SetOneofFloat(3.1415) },
			clear:  func() { x.ClearOneofFloat() },
			has:    func() bool { return x.HasOneofFloat() },
			isZero: func() bool { return x.GetOneofFloat() == 0.0 },
		},
		{
			fName:  "oneof_double",
			set:    func() { x.SetOneofDouble(3e+8) },
			clear:  func() { x.ClearOneofDouble() },
			has:    func() bool { return x.HasOneofDouble() },
			isZero: func() bool { return x.GetOneofDouble() == 0.0 },
		},
		{
			fName:  "oneof_enum",
			set:    func() { x.SetOneofEnum(testopaquepb.TestAllTypes_BAZ) },
			clear:  func() { x.ClearOneofEnum() },
			has:    func() bool { return x.HasOneofEnum() },
			isZero: func() bool { return x.GetOneofEnum() == 0 },
		},
	}

	for i, mv := range tab {
		x.ClearOneofField()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v", got, want)
		}
		if got, want := mv.isZero(), true; got != want {
			t.Errorf("Get on empty oneof member did not return zero value, got %v, expected %v (%s)", got, want, mv.fName)
		}
		mv.set()

		if got, want := x.HasOneofField(), true; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.isZero(), false; got != want {
			t.Errorf("Get on non-empty oneof member did return zero value, got %v, expected %v (%s)", got, want, mv.fName)
		}

		mv.clear()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.isZero(), true; got != want {
			t.Errorf("Get on empty oneof member did not return zero value, got %v, expected %v (%s)", got, want, mv.fName)
		}
		other := tab[(i+1)%len(tab)]
		mv.set()
		other.set()

		if got, want := x.HasOneofField(), true; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.isZero(), true; got != want {
			t.Errorf("Get on wrong oneof member did not return zero value, got %v, expected %v (%s)", got, want, mv.fName)
		}
		other.clear()
		if got, want := x.HasOneofField(), false; got != want {
			t.Errorf("HasOneofField returned %v, expected %v (%s)", got, want, mv.fName)
		}
	}
	x = nil
	for _, mv := range tab {
		if got, want := mv.isZero(), true; got != want {
			t.Errorf("Get on nil receiver did not return zero value, got %v, expected %v (%s)", got, want, mv.fName)
		}
		if got, want := mv.has(), false; got != want {
			t.Errorf("Has on nil receiver failed, got %v, expected %v (%s)", got, want, mv.fName)
		}
	}
}
