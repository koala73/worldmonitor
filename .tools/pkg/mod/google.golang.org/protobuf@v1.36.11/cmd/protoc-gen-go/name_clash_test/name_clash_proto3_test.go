// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package name_clash_test

import (
	"testing"

	"google.golang.org/protobuf/proto"

	hpb "google.golang.org/protobuf/cmd/protoc-gen-go/testdata/nameclash/test_name_clash_hybrid3"
	opb "google.golang.org/protobuf/cmd/protoc-gen-go/testdata/nameclash/test_name_clash_opaque3"
	pb "google.golang.org/protobuf/cmd/protoc-gen-go/testdata/nameclash/test_name_clash_open3"
)

// TestOpenMangling3 tests the backwards compatible mangling of fields
// who clashes with the getters. The expected behavior, which is
// somewhat surprising, is documented in the proto
// test_name_clash_open.proto itself.
func TestOpenMangling3(t *testing.T) {
	m1 := &pb.M1{
		Foo:       makeOpenM0(1),
		GetFoo_:   makeOpenM0(2),
		GetGetFoo: makeOpenM0(3),
	}
	if m1.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m1.GetFoo().GetI1(), m1)
	}
	if m1.GetGetFoo_().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m1.GetGetFoo_().GetI1(), m1)
	}
	if m1.GetGetGetFoo().GetI1() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m1.GetGetGetFoo().GetI1(), m1)
	}
	m2 := &pb.M2{
		Foo:       makeOpenM0(1),
		GetFoo_:   makeOpenM0(2),
		GetGetFoo: makeOpenM0(3),
	}
	if m2.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m2.GetFoo().GetI1(), m2)
	}
	if m2.GetGetFoo_().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m2.GetGetFoo_().GetI1(), m2)
	}
	if m2.GetGetGetFoo().GetI1() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m2.GetGetGetFoo().GetI1(), m2)
	}
	m3 := &pb.M3{
		Foo_:       makeOpenM0(1),
		GetFoo:     makeOpenM0(2),
		GetGetFoo_: makeOpenM0(3),
	}
	if m3.GetFoo_().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m3.GetFoo_().GetI1(), m3)
	}
	if m3.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m3.GetGetFoo().GetI1(), m3)
	}
	if m3.GetGetGetFoo_().GetI1() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m3.GetGetGetFoo_().GetI1(), m3)
	}

	m4 := &pb.M4{
		GetFoo:     makeOpenM0(2),
		GetGetFoo_: &pb.M4_GetGetGetFoo{GetGetGetFoo: 3},
		Foo_:       makeOpenM0(1),
	}
	if m4.GetFoo_().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m4.GetFoo_().GetI1(), m4)
	}
	if m4.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m4.GetGetFoo().GetI1(), m4)
	}
	if m4.GetGetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m4.GetGetGetGetFoo(), m4)
	}

	m5 := &pb.M5{
		GetFoo:       makeOpenM0(2),
		GetGetGetFoo: &pb.M5_GetGetFoo_{GetGetFoo_: 3},
		Foo_:         makeOpenM0(1),
	}
	if m5.GetFoo_().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m5.GetFoo_().GetI1(), m5)
	}
	if m5.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m5.GetGetFoo().GetI1(), m5)
	}
	if m5.GetGetGetFoo_() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m5.GetGetGetFoo_(), m5)
	}

	m6 := &pb.M6{
		GetGetFoo: &pb.M6_GetGetGetFoo{GetGetGetFoo: 3},
		GetFoo_:   makeOpenM0(2),
		Foo:       makeOpenM0(1),
	}
	if m6.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m6.GetFoo().GetI1(), m6)
	}
	if m6.GetGetFoo_().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m6.GetGetFoo_().GetI1(), m6)
	}
	if m6.GetGetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_get_foo' has unexpected value %v for %T (expected 3)", m6.GetGetGetGetFoo(), m6)
	}

	m7 := &pb.M7{
		GetGetFoo: &pb.M7_GetFoo_{GetFoo_: 3},
		Foo:       makeOpenM0(1),
	}
	if m7.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m7.GetFoo().GetI1(), m7)
	}
	if m7.GetGetFoo_() != 3 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m7.GetGetFoo_(), m7)
	}
	m7.GetGetFoo = &pb.M7_Bar{Bar: true}
	if !m7.GetBar() {
		t.Errorf("Proto field 'bar' has unexpected value %v for %T (expected 3)", m7.GetBar(), m7)
	}

	m8 := &pb.M8{
		GetGetGetFoo_: &pb.M8_GetGetFoo{GetGetFoo: 3},
		GetFoo_:       makeOpenM0(2),
		Foo:           makeOpenM0(1),
	}
	if m8.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m8.GetFoo().GetI1(), m8)
	}
	if m8.GetGetFoo_().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m8.GetGetFoo_().GetI1(), m8)
	}
	if m8.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m8.GetGetGetFoo(), m8)
	}

	m9 := &pb.M9{
		GetGetGetFoo_: &pb.M9_GetGetFoo{GetGetFoo: 3},
		Foo:           makeOpenM0(1),
	}
	if m9.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m9.GetFoo(), m9)
	}
	if m9.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m9.GetGetGetFoo(), m9)
	}
	m9.GetGetGetFoo_ = &pb.M9_GetFoo_{GetFoo_: 2}
	if m9.GetGetFoo_() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m9.GetGetFoo_(), m9)
	}

}

// TestHybridMangling3 tests the backwards compatible mangling as well
// as new style mangling of fields who clashes with the getters. The
// expected behavior, which is somewhat surprising, is documented in
// the proto test_name_clash_hybrid.proto itself.
func TestHybridMangling3(t *testing.T) {
	m1 := hpb.M1_builder{
		Foo:       makeHybridM0(1),
		GetFoo:    makeHybridM0(2),
		GetGetFoo: makeHybridM0(3),
	}.Build()
	if m1.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m1.GetFoo().GetI1(), m1)
	}
	if m1.Get_Foo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m1.GetFoo().GetI1(), m1)
	}
	if m1.GetGetFoo_().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m1.GetGetFoo_().GetI1(), m1)
	}
	if m1.Get_GetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m1.GetGetFoo_().GetI1(), m1)
	}
	if m1.GetGetGetFoo().GetI1() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m1.GetGetGetFoo().GetI1(), m1)
	}
	checkNameConsistency(t, m1)
	m2 := hpb.M2_builder{
		Foo:       makeHybridM0(1),
		GetFoo:    makeHybridM0(2),
		GetGetFoo: makeHybridM0(3),
	}.Build()
	if m2.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m2.GetFoo().GetI1(), m2)
	}
	if m2.Get_Foo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m2.GetFoo().GetI1(), m2)
	}
	if m2.GetGetFoo_().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m2.GetGetFoo_().GetI1(), m2)
	}
	if m2.Get_GetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m2.GetGetFoo_().GetI1(), m2)
	}
	if m2.GetGetGetFoo().GetI1() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m2.GetGetGetFoo().GetI1(), m2)
	}
	checkNameConsistency(t, m2)
	m3 := hpb.M3_builder{
		Foo:       makeHybridM0(1),
		GetFoo:    makeHybridM0(2),
		GetGetFoo: makeHybridM0(3),
	}.Build()
	if m3.GetFoo_().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m3.GetFoo_().GetI1(), m3)
	}
	if m3.Get_Foo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m3.GetFoo_().GetI1(), m3)
	}
	if m3.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m3.GetGetFoo().GetI1(), m3)
	}
	if m3.Get_GetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m3.GetGetFoo().GetI1(), m3)
	}
	if m3.GetGetGetFoo_().GetI1() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m3.GetGetGetFoo_().GetI1(), m3)
	}
	checkNameConsistency(t, m3)

	m4 := hpb.M4_builder{
		GetFoo:       makeHybridM0(2),
		GetGetGetFoo: proto.Int32(3),
		Foo:          makeHybridM0(1),
	}.Build()
	if m4.GetFoo_().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m4.GetFoo_().GetI1(), m4)
	}
	if m4.Get_Foo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m4.Get_Foo().GetI1(), m4)
	}
	if m4.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m4.GetGetFoo().GetI1(), m4)
	}
	if m4.Get_GetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m4.Get_GetFoo().GetI1(), m4)
	}
	if m4.GetGetGetFoo_().(*hpb.M4_GetGetGetFoo).GetGetGetFoo != 3 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 3)", m4.GetGetGetFoo_(), m4)
	}
	if !m4.HasGetGetFoo() {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected true)", m4.HasGetGetFoo(), m4)
	}
	if m4.GetGetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_get_foo' has unexpected value %v for %T (expected 3)", m4.GetGetGetGetFoo(), m4)
	}
	checkNameConsistency(t, m4)

	m5 := hpb.M5_builder{
		GetFoo:    makeHybridM0(2),
		GetGetFoo: proto.Int32(3),
		Foo:       makeHybridM0(1),
	}.Build()
	if m5.GetFoo_().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m5.GetFoo_().GetI1(), m5)
	}
	if m5.Get_Foo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m5.Get_Foo().GetI1(), m4)
	}
	if m5.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m5.GetGetFoo().GetI1(), m5)
	}
	if m5.Get_GetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m5.Get_GetFoo().GetI1(), m4)
	}
	if m5.GetGetGetFoo_() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m5.GetGetGetFoo_(), m5)
	}
	if m5.Get_GetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m5.Get_GetGetFoo(), m5)
	}
	checkNameConsistency(t, m5)

	m6 := hpb.M6_builder{
		GetGetGetFoo: proto.Int32(3),
		GetFoo:       makeHybridM0(2),
		Foo:          makeHybridM0(1),
	}.Build()
	if m6.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m6.GetFoo().GetI1(), m6)
	}
	if m6.Get_Foo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m6.Get_Foo().GetI1(), m6)
	}
	if m6.GetGetFoo_().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m6.GetGetFoo_().GetI1(), m6)
	}
	if m6.Get_GetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m6.Get_GetFoo().GetI1(), m6)
	}
	if m6.GetGetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_get_foo' has unexpected value %v for %T (expected 3)", m6.GetGetGetGetFoo(), m6)
	}
	checkNameConsistency(t, m6)

	m7 := hpb.M7_builder{
		GetFoo: proto.Int32(3),
		Foo:    makeHybridM0(1),
	}.Build()
	if m7.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m7.GetFoo().GetI1(), m7)
	}
	if m7.Get_Foo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m7.Get_Foo().GetI1(), m7)
	}
	if m7.GetGetFoo_() != 3 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 3)", m7.GetGetFoo_(), m7)
	}
	if m7.Get_GetFoo() != 3 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 3)", m7.Get_GetFoo(), m7)
	}
	m7.SetBar(true)
	if !m7.GetBar() {
		t.Errorf("Proto field 'bar' has unexpected value %v for %T (expected 3)", m7.GetBar(), m7)
	}
	checkNameConsistency(t, m7)

	m8 := hpb.M8_builder{
		GetGetFoo: proto.Int32(3),
		GetFoo:    makeHybridM0(2),
		Foo:       makeHybridM0(1),
	}.Build()
	if m8.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m8.GetFoo().GetI1(), m8)
	}
	if m8.Get_Foo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m8.Get_Foo().GetI1(), m8)
	}
	if m8.GetGetFoo_().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m8.GetGetFoo_().GetI1(), m8)
	}
	if m8.Get_GetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m8.Get_GetFoo().GetI1(), m8)
	}
	if m8.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m8.GetGetGetFoo(), m8)
	}
	checkNameConsistency(t, m8)

	m9 := hpb.M9_builder{
		GetGetFoo: proto.Int32(3),
		Foo:       makeHybridM0(1),
	}.Build()
	if m9.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m9.GetFoo().GetI1(), m9)
	}
	if m9.Get_Foo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m9.Get_Foo().GetI1(), m9)
	}
	if m9.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m9.GetGetGetFoo(), m9)
	}
	if m9.Get_GetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m9.Get_GetGetFoo(), m9)
	}
	m9.Set_GetFoo(2)
	if m9.GetGetFoo_() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m9.GetGetFoo_(), m9)
	}
	if m9.Get_GetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m9.Get_GetFoo(), m9)
	}
	checkNameConsistency(t, m9)
	m10 := hpb.M10_builder{
		Foo:    makeHybridM0(1),
		SetFoo: makeHybridM0(2),
	}.Build()
	m10.Set_Foo(makeHybridM0(47))
	if m10.Get_Foo().GetI1() != 47 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 47)", m10.Get_Foo().GetI1(), m10)
	}
	m10.SetSetFoo(makeHybridM0(11))
	if m10.GetSetFoo().GetI1() != 11 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 11)", m10.GetSetFoo().GetI1(), m10)
	}
	checkNameConsistency(t, m10)
	m11 := hpb.M11_builder{
		Foo:       makeHybridM0(1),
		SetSetFoo: proto.Int32(2),
	}.Build()
	m11.Set_Foo(makeHybridM0(47))
	if m11.Get_Foo().GetI1() != 47 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 47)", m11.Get_Foo().GetI1(), m11)
	}
	m11.SetSetSetFoo(11)
	if m11.GetSetSetFoo() != 11 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 11)", m11.GetSetSetFoo(), m11)
	}
	checkNameConsistency(t, m11)
	m12 := hpb.M12_builder{
		Foo:    makeHybridM0(1),
		SetFoo: proto.Int32(2),
	}.Build()
	m12.Set_Foo(makeHybridM0(47))
	if m12.Get_Foo().GetI1() != 47 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 47)", m12.Get_Foo().GetI1(), m12)
	}
	m12.Set_SetFoo(11)
	if m12.Get_SetFoo() != 11 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 11)", m12.Get_SetFoo(), m12)
	}
	checkNameConsistency(t, m12)
	m13 := hpb.M13_builder{
		Foo:    makeHybridM0(1),
		HasFoo: makeHybridM0(2),
	}.Build()
	if !m13.Has_Foo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m13.Has_Foo(), m13)
	}
	if !m13.HasHasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m13.HasHasFoo(), m13)
	}
	checkNameConsistency(t, m13)
	m14 := hpb.M14_builder{
		Foo:       makeHybridM0(1),
		HasHasFoo: proto.Int32(2),
	}.Build()
	if !m14.Has_Foo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m14.Has_Foo(), m14)
	}
	if !m14.Has_HasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m14.Has_HasFoo(), m14)
	}
	if !m14.HasHasHasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m14.HasHasHasFoo(), m14)
	}
	checkNameConsistency(t, m14)
	m15 := hpb.M15_builder{
		Foo:    makeHybridM0(1),
		HasFoo: proto.Int32(2),
	}.Build()
	if !m15.Has_Foo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m15.Has_Foo(), m15)
	}
	if !m15.Has_HasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m15.Has_HasFoo(), m15)
	}
	if !m15.HasHasHasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m15.HasHasHasFoo(), m15)
	}
	checkNameConsistency(t, m15)
	m16 := hpb.M16_builder{
		Foo:      makeHybridM0(1),
		ClearFoo: makeHybridM0(2),
	}.Build()
	m16.Clear_Foo()
	if m16.Has_Foo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m16.Has_Foo(), m16)
	}
	m16.ClearClearFoo()
	if m16.HasClearFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m16.HasClearFoo(), m16)
	}
	checkNameConsistency(t, m16)
	m17 := hpb.M17_builder{
		Foo:           makeHybridM0(1),
		ClearClearFoo: proto.Int32(2),
	}.Build()
	m17.Clear_Foo()
	if m17.Has_Foo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m17.Has_Foo(), m17)
	}
	m17.ClearClearClearFoo()
	if m17.HasClearClearFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m17.HasClearClearFoo(), m17)
	}
	checkNameConsistency(t, m17)
	m18 := hpb.M18_builder{
		Foo:      makeHybridM0(1),
		ClearFoo: proto.Int32(2),
	}.Build()
	m18.Clear_Foo()
	if m18.Has_Foo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m18.Has_Foo(), m18)
	}
	m18.Clear_ClearFoo()
	if m18.Has_ClearFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m18.Has_ClearFoo(), m18)
	}
	checkNameConsistency(t, m18)
	m19 := hpb.M19_builder{
		Foo:      makeHybridM0(1),
		WhichFoo: proto.Int32(2),
	}.Build()
	if m19.WhichWhichWhichFoo() != hpb.M19_WhichFoo_case {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected M19_ClearFoo_case)", m19.WhichWhichWhichFoo(), m19)
	}
	checkNameConsistency(t, m19)
	m20 := hpb.M20_builder{
		Foo:           makeHybridM0(1),
		WhichWhichFoo: proto.Int32(2),
	}.Build()
	if m20.Which_WhichFoo() != hpb.M20_WhichWhichFoo_case {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected M20_WhichWhichFoo_case)", m20.Which_WhichFoo(), m20)
	}
	checkNameConsistency(t, m20)

}

// TestOpaqueMangling3 tests the backwards compatible mangling as well
// as new style mangling of fields who clashes with the getters. The
// expected behavior, which is somewhat surprising, is documented in
// the proto test_name_clash_opaque.proto itself.
func TestOpaqueMangling3(t *testing.T) {
	m1 := opb.M1_builder{
		Foo:       makeOpaqueM0(1),
		GetFoo:    makeOpaqueM0(2),
		GetGetFoo: makeOpaqueM0(3),
	}.Build()
	if m1.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m1.GetFoo().GetI1(), m1)
	}
	if m1.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m1.GetGetFoo().GetI1(), m1)
	}
	if m1.GetGetGetFoo().GetI1() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m1.GetGetGetFoo().GetI1(), m1)
	}
	checkNameConsistency(t, m1)
	m2 := opb.M2_builder{
		Foo:       makeOpaqueM0(1),
		GetFoo:    makeOpaqueM0(2),
		GetGetFoo: makeOpaqueM0(3),
	}.Build()
	if m2.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m2.GetFoo().GetI1(), m2)
	}
	if m2.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m2.GetGetFoo().GetI1(), m2)
	}
	if m2.GetGetGetFoo().GetI1() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m2.GetGetGetFoo().GetI1(), m2)
	}
	checkNameConsistency(t, m2)
	m3 := opb.M3_builder{
		Foo:       makeOpaqueM0(1),
		GetFoo:    makeOpaqueM0(2),
		GetGetFoo: makeOpaqueM0(3),
	}.Build()
	if m3.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m3.GetFoo().GetI1(), m3)
	}
	if m3.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m3.GetGetFoo().GetI1(), m3)
	}
	if m3.GetGetGetFoo().GetI1() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m3.GetGetGetFoo().GetI1(), m3)
	}
	checkNameConsistency(t, m3)

	m4 := opb.M4_builder{
		GetFoo:       makeOpaqueM0(2),
		GetGetGetFoo: proto.Int32(3),
		Foo:          makeOpaqueM0(1),
	}.Build()
	if m4.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m4.GetFoo().GetI1(), m4)
	}
	if m4.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m4.GetGetFoo().GetI1(), m4)
	}
	if !m4.HasGetGetFoo() {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected true)", m4.HasGetGetFoo(), m4)
	}
	if m4.GetGetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_get_foo' has unexpected value %v for %T (expected 3)", m4.GetGetGetGetFoo(), m4)
	}
	checkNameConsistency(t, m4)

	m5 := opb.M5_builder{
		GetFoo:    makeOpaqueM0(2),
		GetGetFoo: proto.Int32(3),
		Foo:       makeOpaqueM0(1),
	}.Build()
	if m5.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m5.GetFoo().GetI1(), m5)
	}
	if m5.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m5.GetGetFoo().GetI1(), m5)
	}
	if m5.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m5.GetGetGetFoo(), m5)
	}
	checkNameConsistency(t, m5)

	m6 := opb.M6_builder{
		GetGetGetFoo: proto.Int32(3),
		GetFoo:       makeOpaqueM0(2),
		Foo:          makeOpaqueM0(1),
	}.Build()
	if m6.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m6.GetFoo().GetI1(), m6)
	}
	if m6.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m6.GetGetFoo().GetI1(), m6)
	}
	if m6.GetGetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_get_foo' has unexpected value %v for %T (expected 3)", m6.GetGetGetGetFoo(), m6)
	}
	checkNameConsistency(t, m6)

	m7 := opb.M7_builder{
		GetFoo: proto.Int32(3),
		Foo:    makeOpaqueM0(1),
	}.Build()
	if m7.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m7.GetFoo().GetI1(), m7)
	}
	if m7.GetGetFoo() != 3 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 3)", m7.GetGetFoo(), m7)
	}
	m7.SetBar(true)
	if !m7.GetBar() {
		t.Errorf("Proto field 'bar' has unexpected value %v for %T (expected true)", m7.GetBar(), m7)
	}
	checkNameConsistency(t, m7)

	m8 := opb.M8_builder{
		GetGetFoo: proto.Int32(3),
		GetFoo:    makeOpaqueM0(2),
		Foo:       makeOpaqueM0(1),
	}.Build()
	if m8.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m8.GetFoo().GetI1(), m8)
	}
	if m8.GetGetFoo().GetI1() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m8.GetGetFoo().GetI1(), m8)
	}
	if m8.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m8.GetGetGetFoo(), m8)
	}
	checkNameConsistency(t, m8)

	m9 := opb.M9_builder{
		GetGetFoo: proto.Int32(3),
		Foo:       makeOpaqueM0(1),
	}.Build()
	if m9.GetFoo().GetI1() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m9.GetFoo().GetI1(), m9)
	}
	if m9.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m9.GetGetGetFoo(), m9)
	}
	m9.SetGetFoo(2)
	if m9.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m9.GetGetFoo(), m9)
	}
	checkNameConsistency(t, m9)
	m10 := opb.M10_builder{
		Foo:    makeOpaqueM0(1),
		SetFoo: makeOpaqueM0(2),
	}.Build()
	m10.SetFoo(makeOpaqueM0(48))
	if m10.GetFoo().GetI1() != 48 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 48)", m10.GetFoo().GetI1(), m10)
	}
	m10.SetSetFoo(makeOpaqueM0(11))
	if m10.GetSetFoo().GetI1() != 11 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 11)", m10.GetSetFoo().GetI1(), m10)
	}
	checkNameConsistency(t, m10)
	m11 := opb.M11_builder{
		Foo:       makeOpaqueM0(1),
		SetSetFoo: proto.Int32(2),
	}.Build()
	m11.SetFoo(makeOpaqueM0(48))
	if m11.GetFoo().GetI1() != 48 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 48)", m11.GetFoo().GetI1(), m11)
	}
	m11.SetSetSetFoo(11)
	if m11.GetSetSetFoo() != 11 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 11)", m11.GetSetSetFoo(), m11)
	}
	checkNameConsistency(t, m11)
	m12 := opb.M12_builder{
		Foo:    makeOpaqueM0(1),
		SetFoo: proto.Int32(2),
	}.Build()
	m12.SetFoo(makeOpaqueM0(48))
	if m12.GetFoo().GetI1() != 48 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 48)", m12.GetFoo().GetI1(), m12)
	}
	m12.SetSetFoo(12)
	if m12.GetSetFoo() != 12 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 12)", m12.GetSetFoo(), m12)
	}
	checkNameConsistency(t, m12)
	m13 := opb.M13_builder{
		Foo:    makeOpaqueM0(1),
		HasFoo: makeOpaqueM0(2),
	}.Build()
	if !m13.HasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m13.HasFoo(), m13)
	}
	if !m13.HasHasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m13.HasHasFoo(), m13)
	}
	checkNameConsistency(t, m13)
	m14 := opb.M14_builder{
		Foo:       makeOpaqueM0(1),
		HasHasFoo: proto.Int32(2),
	}.Build()
	if !m14.HasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m14.HasFoo(), m14)
	}
	if !m14.HasHasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m14.HasHasFoo(), m14)
	}
	if !m14.HasHasHasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m14.HasHasHasFoo(), m14)
	}
	checkNameConsistency(t, m14)
	m15 := opb.M15_builder{
		Foo:    makeOpaqueM0(1),
		HasFoo: proto.Int32(2),
	}.Build()
	if !m15.HasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m15.HasFoo(), m15)
	}
	if !m15.HasHasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m15.HasHasFoo(), m15)
	}
	if !m15.HasHasHasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m15.HasHasHasFoo(), m15)
	}
	checkNameConsistency(t, m15)
	m16 := opb.M16_builder{
		Foo:      makeOpaqueM0(1),
		ClearFoo: makeOpaqueM0(2),
	}.Build()
	m16.SetFoo(makeOpaqueM0(4711))
	m16.ClearFoo()
	if m16.HasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m16.HasFoo(), m16)
	}
	m16.ClearClearFoo()
	if m16.HasClearFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m16.HasClearFoo(), m16)
	}
	checkNameConsistency(t, m16)
	m17 := opb.M17_builder{
		Foo:           makeOpaqueM0(1),
		ClearClearFoo: proto.Int32(2),
	}.Build()
	m17.SetFoo(makeOpaqueM0(4711))
	m17.ClearFoo()
	if m17.HasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m17.HasFoo(), m17)
	}
	m17.ClearClearClearFoo()
	if m17.HasClearClearFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m17.HasClearClearFoo(), m17)
	}
	checkNameConsistency(t, m17)
	m18 := opb.M18_builder{
		Foo:      makeOpaqueM0(1),
		ClearFoo: proto.Int32(2),
	}.Build()
	m18.SetFoo(makeOpaqueM0(4711))
	m18.ClearFoo()
	if m18.HasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m18.HasFoo(), m18)
	}
	m18.SetClearFoo(13)
	m18.ClearClearFoo()
	if m18.HasClearFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected false)", m18.HasClearFoo(), m18)
	}
	checkNameConsistency(t, m18)
	m19 := opb.M19_builder{
		Foo:      makeOpaqueM0(1),
		WhichFoo: proto.Int32(2),
	}.Build()
	if m19.WhichWhichWhichFoo() != opb.M19_WhichFoo_case {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected M19_ClearFoo_case)", m19.WhichWhichWhichFoo(), m19)
	}
	checkNameConsistency(t, m19)
	m20 := opb.M20_builder{
		Foo:           makeOpaqueM0(1),
		WhichWhichFoo: proto.Int32(2),
	}.Build()
	if m20.WhichWhichFoo() != opb.M20_WhichWhichFoo_case {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected M20_WhichWhichFoo_case)", m20.WhichWhichFoo(), m20)
	}
	checkNameConsistency(t, m20)

}

func makeOpenM0(x int32) *pb.M0 {
	return &pb.M0{
		I1: x,
	}
}

func makeHybridM0(x int32) *hpb.M0 {
	return hpb.M0_builder{
		I1: x,
	}.Build()
}

func makeOpaqueM0(x int32) *opb.M0 {
	return opb.M0_builder{
		I1: x,
	}.Build()
}
