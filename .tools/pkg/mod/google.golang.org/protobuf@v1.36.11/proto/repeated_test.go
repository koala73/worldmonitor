// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package proto_test

import (
	"fmt"
	"reflect"
	"testing"
	"unsafe"

	"google.golang.org/protobuf/internal/impl"
	testhybridpb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_hybrid"
	testopaquepb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_opaque"
	"google.golang.org/protobuf/proto"
)

func TestOpenSetRepeatedNilReceiver(t *testing.T) {
	var x *testhybridpb.TestAllTypes
	expectPanic(t, func() {
		x.SetRepeatedUint32(nil)
	}, "Setting repeated field on nil receiver did not panic.")
}

func TestOpenSetRepeated(t *testing.T) {
	x := &testhybridpb.TestAllTypes{}

	tab := []struct {
		fName  string     // Field name (in proto)
		set    func()     // Set the field to empty slice
		setNil func()     // Set the field to nil
		len    func() int // length of field, -1 if nil
	}{
		{
			fName:  "repeated_int32",
			set:    func() { x.SetRepeatedInt32([]int32{}) },
			setNil: func() { x.SetRepeatedInt32(nil) },
			len: func() int {
				if x.GetRepeatedInt32() == nil {
					return -1
				}
				return len(x.GetRepeatedInt32())
			},
		},
		{
			fName:  "repeated_int64",
			set:    func() { x.SetRepeatedInt64([]int64{}) },
			setNil: func() { x.SetRepeatedInt64(nil) },
			len: func() int {
				if x.GetRepeatedInt64() == nil {
					return -1
				}
				return len(x.GetRepeatedInt64())
			},
		},
		{
			fName:  "repeated_uint32",
			set:    func() { x.SetRepeatedUint32([]uint32{}) },
			setNil: func() { x.SetRepeatedUint32(nil) },
			len: func() int {
				if x.GetRepeatedUint32() == nil {
					return -1
				}
				return len(x.GetRepeatedUint32())
			},
		},
		{
			fName:  "repeated_uint64",
			set:    func() { x.SetRepeatedUint64([]uint64{}) },
			setNil: func() { x.SetRepeatedUint64(nil) },
			len: func() int {
				if x.GetRepeatedUint64() == nil {
					return -1
				}
				return len(x.GetRepeatedUint64())
			},
		},
		{
			fName:  "repeated_sint32",
			set:    func() { x.SetRepeatedSint32([]int32{}) },
			setNil: func() { x.SetRepeatedSint32(nil) },
			len: func() int {
				if x.GetRepeatedSint32() == nil {
					return -1
				}
				return len(x.GetRepeatedSint32())
			},
		},
		{
			fName:  "repeated_sint64",
			set:    func() { x.SetRepeatedSint64([]int64{}) },
			setNil: func() { x.SetRepeatedSint64(nil) },
			len: func() int {
				if x.GetRepeatedSint64() == nil {
					return -1
				}
				return len(x.GetRepeatedSint64())
			},
		},
		{
			fName:  "repeated_fixed32",
			set:    func() { x.SetRepeatedFixed32([]uint32{}) },
			setNil: func() { x.SetRepeatedFixed32(nil) },
			len: func() int {
				if x.GetRepeatedFixed32() == nil {
					return -1
				}
				return len(x.GetRepeatedFixed32())
			},
		},
		{
			fName:  "repeated_fixed64",
			set:    func() { x.SetRepeatedFixed64([]uint64{}) },
			setNil: func() { x.SetRepeatedFixed64(nil) },
			len: func() int {
				if x.GetRepeatedFixed64() == nil {
					return -1
				}
				return len(x.GetRepeatedFixed64())
			},
		},
		{
			fName:  "repeated_sfixed32",
			set:    func() { x.SetRepeatedSfixed32([]int32{}) },
			setNil: func() { x.SetRepeatedSfixed32(nil) },
			len: func() int {
				if x.GetRepeatedSfixed32() == nil {
					return -1
				}
				return len(x.GetRepeatedSfixed32())
			},
		},
		{
			fName:  "repeated_sfixed64",
			set:    func() { x.SetRepeatedSfixed64([]int64{}) },
			setNil: func() { x.SetRepeatedSfixed64(nil) },
			len: func() int {
				if x.GetRepeatedSfixed64() == nil {
					return -1
				}
				return len(x.GetRepeatedSfixed64())
			},
		},
		{
			fName:  "repeated_float",
			set:    func() { x.SetRepeatedFloat([]float32{}) },
			setNil: func() { x.SetRepeatedFloat(nil) },
			len: func() int {
				if x.GetRepeatedFloat() == nil {
					return -1
				}
				return len(x.GetRepeatedFloat())
			},
		},
		{
			fName:  "repeated_double",
			set:    func() { x.SetRepeatedDouble([]float64{}) },
			setNil: func() { x.SetRepeatedDouble(nil) },
			len: func() int {
				if x.GetRepeatedDouble() == nil {
					return -1
				}
				return len(x.GetRepeatedDouble())
			},
		},
		{
			fName:  "repeated_bool",
			set:    func() { x.SetRepeatedBool([]bool{}) },
			setNil: func() { x.SetRepeatedBool(nil) },
			len: func() int {
				if x.GetRepeatedBool() == nil {
					return -1
				}
				return len(x.GetRepeatedBool())
			},
		},
		{
			fName:  "repeated_string",
			set:    func() { x.SetRepeatedString([]string{}) },
			setNil: func() { x.SetRepeatedString(nil) },
			len: func() int {
				if x.GetRepeatedString() == nil {
					return -1
				}
				return len(x.GetRepeatedString())
			},
		},
		{
			fName:  "repeated_bytes",
			set:    func() { x.SetRepeatedBytes([][]byte{}) },
			setNil: func() { x.SetRepeatedBytes(nil) },
			len: func() int {
				if x.GetRepeatedBytes() == nil {
					return -1
				}
				return len(x.GetRepeatedBytes())
			},
		},
		{
			fName:  "RepeatedGroup",
			set:    func() { x.SetRepeatedgroup([]*testhybridpb.TestAllTypes_RepeatedGroup{}) },
			setNil: func() { x.SetRepeatedgroup(nil) },
			len: func() int {
				if x.GetRepeatedgroup() == nil {
					return -1
				}
				return len(x.GetRepeatedgroup())
			},
		},
		{
			fName:  "repeated_nested_message",
			set:    func() { x.SetRepeatedNestedMessage([]*testhybridpb.TestAllTypes_NestedMessage{}) },
			setNil: func() { x.SetRepeatedNestedMessage(nil) },
			len: func() int {
				if x.GetRepeatedNestedMessage() == nil {
					return -1
				}
				return len(x.GetRepeatedNestedMessage())
			},
		},
		{
			fName:  "repeated_nested_enum",
			set:    func() { x.SetRepeatedNestedEnum([]testhybridpb.TestAllTypes_NestedEnum{}) },
			setNil: func() { x.SetRepeatedNestedEnum(nil) },
			len: func() int {
				if x.GetRepeatedNestedEnum() == nil {
					return -1
				}
				return len(x.GetRepeatedNestedEnum())
			},
		},
	}

	for _, mv := range tab {
		if mv.len() != -1 {
			t.Errorf("Repeated field %s was not nil to start with ", mv.fName)
		}
		mv.set()
		if mv.len() != 0 {
			t.Errorf("Repeated field %s did not retain empty slice ", mv.fName)
		}
		b, err := proto.Marshal(x)
		if err != nil {
			t.Fatalf("Failed to marshal message, err = %v", err)
		}
		proto.Unmarshal(b, x)
		if mv.len() != -1 {
			t.Errorf("Repeated field %s was not nil to start with ", mv.fName)
		}
		mv.set()
		mv.setNil()
		if mv.len() != -1 {
			t.Errorf("Repeated field %s was not nil event though we set it to ", mv.fName)
		}

	}

	// Check that we actually retain the same slice
	s := make([]testhybridpb.TestAllTypes_NestedEnum, 0, 455)
	x.SetRepeatedNestedEnum(s)
	if got, want := cap(x.GetRepeatedNestedEnum()), 455; got != want {
		t.Errorf("cap(x.GetRepeatedNestedEnum()) returned %v, expected %v", got, want)
	}
	// Do this for a message too
	s2 := make([]*testhybridpb.TestAllTypes_NestedMessage, 0, 544)
	x.SetRepeatedNestedMessage(s2)
	if got, want := cap(x.GetRepeatedNestedMessage()), 544; got != want {
		t.Errorf("cap(x.GetRepeatedNestedMessage()) returned %v, expected %v", got, want)
	}
	// Check special bytes behavior
	x.SetOptionalBytes(nil)
	if got, want := x.HasOptionalBytes(), true; got != want {
		t.Errorf("HasOptionalBytes after setting to nil returned %v, expected %v", got, want)
	}
	if got := x.GetOptionalBytes(); got == nil || len(got) != 0 {
		t.Errorf("GetOptionalBytes after setting to nil returned %v, expected %v", got, []byte{})
	}

}

func TestOpaqueSetRepeatedNilReceiver(t *testing.T) {
	var x *testopaquepb.TestAllTypes
	expectPanic(t, func() {
		x.SetRepeatedUint32(nil)
	}, "Setting repeated field on nil receiver did not panic.")
}

func TestOpaqueSetRepeated(t *testing.T) {
	for _, mode := range []bool{true, false} {
		impl.EnableLazyUnmarshal(mode)
		t.Run(fmt.Sprintf("LazyUnmarshal_%t", mode), testOpaqueSetRepeatedSub)
	}
}

func testOpaqueSetRepeatedSub(t *testing.T) {
	x := &testopaquepb.TestAllTypes{}

	tab := []struct {
		fName  string     // Field name (in proto)
		set    func()     // Set the field to empty slice
		setNil func()     // Set the field to nil
		len    func() int // length of field, -1 if nil
	}{
		{
			fName:  "repeated_int32",
			set:    func() { x.SetRepeatedInt32([]int32{}) },
			setNil: func() { x.SetRepeatedInt32(nil) },
			len: func() int {
				if x.GetRepeatedInt32() == nil {
					return -1
				}
				return len(x.GetRepeatedInt32())
			},
		},
		{
			fName:  "repeated_int64",
			set:    func() { x.SetRepeatedInt64([]int64{}) },
			setNil: func() { x.SetRepeatedInt64(nil) },
			len: func() int {
				if x.GetRepeatedInt64() == nil {
					return -1
				}
				return len(x.GetRepeatedInt64())
			},
		},
		{
			fName:  "repeated_uint32",
			set:    func() { x.SetRepeatedUint32([]uint32{}) },
			setNil: func() { x.SetRepeatedUint32(nil) },
			len: func() int {
				if x.GetRepeatedUint32() == nil {
					return -1
				}
				return len(x.GetRepeatedUint32())
			},
		},
		{
			fName:  "repeated_uint64",
			set:    func() { x.SetRepeatedUint64([]uint64{}) },
			setNil: func() { x.SetRepeatedUint64(nil) },
			len: func() int {
				if x.GetRepeatedUint64() == nil {
					return -1
				}
				return len(x.GetRepeatedUint64())
			},
		},
		{
			fName:  "repeated_sint32",
			set:    func() { x.SetRepeatedSint32([]int32{}) },
			setNil: func() { x.SetRepeatedSint32(nil) },
			len: func() int {
				if x.GetRepeatedSint32() == nil {
					return -1
				}
				return len(x.GetRepeatedSint32())
			},
		},
		{
			fName:  "repeated_sint64",
			set:    func() { x.SetRepeatedSint64([]int64{}) },
			setNil: func() { x.SetRepeatedSint64(nil) },
			len: func() int {
				if x.GetRepeatedSint64() == nil {
					return -1
				}
				return len(x.GetRepeatedSint64())
			},
		},
		{
			fName:  "repeated_fixed32",
			set:    func() { x.SetRepeatedFixed32([]uint32{}) },
			setNil: func() { x.SetRepeatedFixed32(nil) },
			len: func() int {
				if x.GetRepeatedFixed32() == nil {
					return -1
				}
				return len(x.GetRepeatedFixed32())
			},
		},
		{
			fName:  "repeated_fixed64",
			set:    func() { x.SetRepeatedFixed64([]uint64{}) },
			setNil: func() { x.SetRepeatedFixed64(nil) },
			len: func() int {
				if x.GetRepeatedFixed64() == nil {
					return -1
				}
				return len(x.GetRepeatedFixed64())
			},
		},
		{
			fName:  "repeated_sfixed32",
			set:    func() { x.SetRepeatedSfixed32([]int32{}) },
			setNil: func() { x.SetRepeatedSfixed32(nil) },
			len: func() int {
				if x.GetRepeatedSfixed32() == nil {
					return -1
				}
				return len(x.GetRepeatedSfixed32())
			},
		},
		{
			fName:  "repeated_sfixed64",
			set:    func() { x.SetRepeatedSfixed64([]int64{}) },
			setNil: func() { x.SetRepeatedSfixed64(nil) },
			len: func() int {
				if x.GetRepeatedSfixed64() == nil {
					return -1
				}
				return len(x.GetRepeatedSfixed64())
			},
		},
		{
			fName:  "repeated_float",
			set:    func() { x.SetRepeatedFloat([]float32{}) },
			setNil: func() { x.SetRepeatedFloat(nil) },
			len: func() int {
				if x.GetRepeatedFloat() == nil {
					return -1
				}
				return len(x.GetRepeatedFloat())
			},
		},
		{
			fName:  "repeated_double",
			set:    func() { x.SetRepeatedDouble([]float64{}) },
			setNil: func() { x.SetRepeatedDouble(nil) },
			len: func() int {
				if x.GetRepeatedDouble() == nil {
					return -1
				}
				return len(x.GetRepeatedDouble())
			},
		},
		{
			fName:  "repeated_bool",
			set:    func() { x.SetRepeatedBool([]bool{}) },
			setNil: func() { x.SetRepeatedBool(nil) },
			len: func() int {
				if x.GetRepeatedBool() == nil {
					return -1
				}
				return len(x.GetRepeatedBool())
			},
		},
		{
			fName:  "repeated_string",
			set:    func() { x.SetRepeatedString([]string{}) },
			setNil: func() { x.SetRepeatedString(nil) },
			len: func() int {
				if x.GetRepeatedString() == nil {
					return -1
				}
				return len(x.GetRepeatedString())
			},
		},
		{
			fName:  "repeated_bytes",
			set:    func() { x.SetRepeatedBytes([][]byte{}) },
			setNil: func() { x.SetRepeatedBytes(nil) },
			len: func() int {
				if x.GetRepeatedBytes() == nil {
					return -1
				}
				return len(x.GetRepeatedBytes())
			},
		},
		{
			fName:  "RepeatedGroup",
			set:    func() { x.SetRepeatedgroup([]*testopaquepb.TestAllTypes_RepeatedGroup{}) },
			setNil: func() { x.SetRepeatedgroup(nil) },
			len: func() int {
				if x.GetRepeatedgroup() == nil {
					return -1
				}
				return len(x.GetRepeatedgroup())
			},
		},
		{
			fName:  "repeated_nested_message",
			set:    func() { x.SetRepeatedNestedMessage([]*testopaquepb.TestAllTypes_NestedMessage{}) },
			setNil: func() { x.SetRepeatedNestedMessage(nil) },
			len: func() int {
				if x.GetRepeatedNestedMessage() == nil {
					return -1
				}
				return len(x.GetRepeatedNestedMessage())
			},
		},
		{
			fName:  "repeated_nested_enum",
			set:    func() { x.SetRepeatedNestedEnum([]testopaquepb.TestAllTypes_NestedEnum{}) },
			setNil: func() { x.SetRepeatedNestedEnum(nil) },
			len: func() int {
				if x.GetRepeatedNestedEnum() == nil {
					return -1
				}
				return len(x.GetRepeatedNestedEnum())
			},
		},
	}

	for _, mv := range tab {
		if mv.len() != -1 {
			t.Errorf("Repeated field %s was not nil to start with ", mv.fName)
		}
		mv.set()
		if mv.len() != 0 {
			t.Errorf("Repeated field %s did not retain empty slice ", mv.fName)
		}
		b, err := proto.Marshal(x)
		if err != nil {
			t.Fatalf("Failed to marshal message, err = %v", err)
		}
		proto.Unmarshal(b, x)
		if mv.len() != -1 {
			t.Errorf("Repeated field %s was not nil to start with ", mv.fName)
		}
		mv.set()
		mv.setNil()
		if mv.len() != -1 {
			t.Errorf("Repeated field %s was not nil event though we set it to ", mv.fName)
		}

	}

	// Check that we actually retain the same slice
	s := make([]testopaquepb.TestAllTypes_NestedEnum, 0, 455)
	x.SetRepeatedNestedEnum(s)
	if got, want := cap(x.GetRepeatedNestedEnum()), 455; got != want {
		t.Errorf("cap(x.GetRepeatedNestedEnum()) returned %v, expected %v", got, want)
	}
	// Do this for a message too
	s2 := make([]*testopaquepb.TestAllTypes_NestedMessage, 0, 544)
	x.SetRepeatedNestedMessage(s2)
	if got, want := cap(x.GetRepeatedNestedMessage()), 544; got != want {
		t.Errorf("cap(x.GetRepeatedNestedMessage()) returned %v, expected %v", got, want)
		t.Errorf("present: %v, isNilen: %v", checkPresent(x, 34), x.GetRepeatedNestedMessage())
	}
	// Check special bytes behavior
	x.SetOptionalBytes(nil)
	if got, want := x.HasOptionalBytes(), true; got != want {
		t.Errorf("HasOptionalBytes after setting to nil returned %v, expected %v", got, want)
	}
	if got := x.GetOptionalBytes(); got == nil || len(got) != 0 {
		t.Errorf("GetOptionalBytes after setting to nil returned %v, expected %v", got, []byte{})
	}
}

func checkPresent(m proto.Message, fn uint32) bool {
	vv := reflect.ValueOf(m).Elem()
	rf := vv.FieldByName("XXX_presence")
	rf = reflect.NewAt(rf.Type(), unsafe.Pointer(rf.UnsafeAddr())).Elem()
	ai := int(fn) / 32
	bit := fn % 32
	ptr := rf.Index(ai).Addr().Interface().(*uint32)
	return (*ptr & (1 << bit)) > 0
}
