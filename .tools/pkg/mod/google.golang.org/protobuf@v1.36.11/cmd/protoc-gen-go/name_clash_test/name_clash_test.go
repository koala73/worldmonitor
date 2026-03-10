// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package name_clash_test

import (
	"reflect"
	"testing"

	"google.golang.org/protobuf/compiler/protogen"
	"google.golang.org/protobuf/internal/genid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	descpb "google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/gofeaturespb"
	"google.golang.org/protobuf/types/pluginpb"

	hpb "google.golang.org/protobuf/cmd/protoc-gen-go/testdata/nameclash/test_name_clash_hybrid"
	opb "google.golang.org/protobuf/cmd/protoc-gen-go/testdata/nameclash/test_name_clash_opaque"
	pb "google.golang.org/protobuf/cmd/protoc-gen-go/testdata/nameclash/test_name_clash_open"
)

// TestOpenMangling tests the backwards compatible mangling of fields
// who clashes with the getters. The expected behavior, which is
// somewhat surprising, is documented in the proto
// test_name_clash_open.proto itself.
func TestOpenMangling(t *testing.T) {
	m1 := &pb.M1{
		Foo:       proto.Int32(1),
		GetFoo_:   proto.Int32(2),
		GetGetFoo: proto.Int32(3),
	}
	if m1.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m1.GetFoo(), m1)
	}
	if m1.GetGetFoo_() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m1.GetGetFoo_(), m1)
	}
	if m1.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m1.GetGetGetFoo(), m1)
	}
	m2 := &pb.M2{
		Foo:       proto.Int32(1),
		GetFoo_:   proto.Int32(2),
		GetGetFoo: proto.Int32(3),
	}
	if m2.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m2.GetFoo(), m2)
	}
	if m2.GetGetFoo_() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m2.GetGetFoo_(), m2)
	}
	if m2.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m2.GetGetGetFoo(), m2)
	}
	m3 := &pb.M3{
		Foo_:       proto.Int32(1),
		GetFoo:     proto.Int32(2),
		GetGetFoo_: proto.Int32(3),
	}
	if m3.GetFoo_() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m3.GetFoo_(), m3)
	}
	if m3.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m3.GetGetFoo(), m3)
	}
	if m3.GetGetGetFoo_() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m3.GetGetGetFoo_(), m3)
	}

	m4 := &pb.M4{
		GetFoo:     proto.Int32(2),
		GetGetFoo_: &pb.M4_GetGetGetFoo{GetGetGetFoo: 3},
		Foo_:       proto.Int32(1),
	}
	if m4.GetFoo_() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m4.GetFoo_(), m4)
	}
	if m4.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m4.GetGetFoo(), m4)
	}
	if m4.GetGetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m4.GetGetGetGetFoo(), m4)
	}

	m5 := &pb.M5{
		GetFoo:       proto.Int32(2),
		GetGetGetFoo: &pb.M5_GetGetFoo_{GetGetFoo_: 3},
		Foo_:         proto.Int32(1),
	}
	if m5.GetFoo_() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m5.GetFoo_(), m5)
	}
	if m5.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m5.GetGetFoo(), m5)
	}
	if m5.GetGetGetFoo_() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m5.GetGetGetFoo_(), m5)
	}

	m6 := &pb.M6{
		GetGetFoo: &pb.M6_GetGetGetFoo{GetGetGetFoo: 3},
		GetFoo_:   proto.Int32(2),
		Foo:       proto.Int32(1),
	}
	if m6.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m6.GetFoo(), m6)
	}
	if m6.GetGetFoo_() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m6.GetGetFoo_(), m6)
	}
	if m6.GetGetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_get_foo' has unexpected value %v for %T (expected 3)", m6.GetGetGetGetFoo(), m6)
	}

	m7 := &pb.M7{
		GetGetFoo: &pb.M7_GetFoo_{GetFoo_: 3},
		Foo:       proto.Int32(1),
	}
	if m7.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m7.GetFoo(), m7)
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
		GetFoo_:       proto.Int32(2),
		Foo:           proto.Int32(1),
	}
	if m8.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m8.GetFoo(), m8)
	}
	if m8.GetGetFoo_() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m8.GetGetFoo_(), m8)
	}
	if m8.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m8.GetGetGetFoo(), m8)
	}

	m9 := &pb.M9{
		GetGetGetFoo_: &pb.M9_GetGetFoo{GetGetFoo: 3},
		Foo:           proto.Int32(1),
	}
	if m9.GetFoo() != 1 {
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

// TestHybridMangling tests the backwards compatible mangling as well
// as new style mangling of fields who clashes with the getters. The
// expected behavior, which is somewhat surprising, is documented in
// the proto test_name_clash_hybrid.proto itself.
func TestHybridMangling(t *testing.T) {
	m1 := hpb.M1_builder{
		Foo:       proto.Int32(1),
		GetFoo:    proto.Int32(2),
		GetGetFoo: proto.Int32(3),
	}.Build()
	if m1.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m1.GetFoo(), m1)
	}
	if m1.Get_Foo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m1.GetFoo(), m1)
	}
	if m1.GetGetFoo_() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m1.GetGetFoo_(), m1)
	}
	if m1.Get_GetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m1.GetGetFoo_(), m1)
	}
	if m1.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m1.GetGetGetFoo(), m1)
	}
	checkNameConsistency(t, m1)
	m2 := hpb.M2_builder{
		Foo:       proto.Int32(1),
		GetFoo:    proto.Int32(2),
		GetGetFoo: proto.Int32(3),
	}.Build()
	if m2.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m2.GetFoo(), m2)
	}
	if m2.Get_Foo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m2.GetFoo(), m2)
	}
	if m2.GetGetFoo_() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m2.GetGetFoo_(), m2)
	}
	if m2.Get_GetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m2.GetGetFoo_(), m2)
	}
	if m2.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m2.GetGetGetFoo(), m2)
	}
	checkNameConsistency(t, m2)
	m3 := hpb.M3_builder{
		Foo:       proto.Int32(1),
		GetFoo:    proto.Int32(2),
		GetGetFoo: proto.Int32(3),
	}.Build()
	if m3.GetFoo_() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m3.GetFoo_(), m3)
	}
	if m3.Get_Foo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m3.GetFoo_(), m3)
	}
	if m3.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m3.GetGetFoo(), m3)
	}
	if m3.Get_GetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m3.GetGetFoo(), m3)
	}
	if m3.GetGetGetFoo_() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m3.GetGetGetFoo_(), m3)
	}
	checkNameConsistency(t, m3)

	m4 := hpb.M4_builder{
		GetFoo:       proto.Int32(2),
		GetGetGetFoo: proto.Int32(3),
		Foo:          proto.Int32(1),
	}.Build()
	if m4.GetFoo_() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m4.GetFoo_(), m4)
	}
	if m4.Get_Foo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m4.Get_Foo(), m4)
	}
	if m4.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m4.GetGetFoo(), m4)
	}
	if m4.Get_GetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m4.Get_GetFoo(), m4)
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
		GetFoo:    proto.Int32(2),
		GetGetFoo: proto.Int32(3),
		Foo:       proto.Int32(1),
	}.Build()
	if m5.GetFoo_() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m5.GetFoo_(), m5)
	}
	if m5.Get_Foo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m5.Get_Foo(), m4)
	}
	if m5.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m5.GetGetFoo(), m5)
	}
	if m5.Get_GetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m5.Get_GetFoo(), m4)
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
		GetFoo:       proto.Int32(2),
		Foo:          proto.Int32(1),
	}.Build()
	if m6.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m6.GetFoo(), m6)
	}
	if m6.Get_Foo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m6.Get_Foo(), m6)
	}
	if m6.GetGetFoo_() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m6.GetGetFoo_(), m6)
	}
	if m6.Get_GetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m6.Get_GetFoo(), m6)
	}
	if m6.GetGetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_get_foo' has unexpected value %v for %T (expected 3)", m6.GetGetGetGetFoo(), m6)
	}
	checkNameConsistency(t, m6)

	m7 := hpb.M7_builder{
		GetFoo: proto.Int32(3),
		Foo:    proto.Int32(1),
	}.Build()
	if m7.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m7.GetFoo(), m7)
	}
	if m7.Get_Foo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m7.Get_Foo(), m7)
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
		GetFoo:    proto.Int32(2),
		Foo:       proto.Int32(1),
	}.Build()
	if m8.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m8.GetFoo(), m8)
	}
	if m8.Get_Foo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m8.Get_Foo(), m8)
	}
	if m8.GetGetFoo_() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m8.GetGetFoo_(), m8)
	}
	if m8.Get_GetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m8.Get_GetFoo(), m8)
	}
	if m8.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m8.GetGetGetFoo(), m8)
	}
	checkNameConsistency(t, m8)

	m9 := hpb.M9_builder{
		GetGetFoo: proto.Int32(3),
		Foo:       proto.Int32(1),
	}.Build()
	if m9.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m9.GetFoo(), m9)
	}
	if m9.Get_Foo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m9.Get_Foo(), m9)
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
		Foo:    proto.Int32(1),
		SetFoo: proto.Int32(2),
	}.Build()
	m10.Set_Foo(47)
	if m10.Get_Foo() != 47 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 47)", m10.Get_Foo(), m10)
	}
	m10.SetSetFoo(11)
	if m10.GetSetFoo() != 11 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 11)", m10.GetSetFoo(), m10)
	}
	checkNameConsistency(t, m10)
	m11 := hpb.M11_builder{
		Foo:       proto.Int32(1),
		SetSetFoo: proto.Int32(2),
	}.Build()
	m11.Set_Foo(47)
	if m11.Get_Foo() != 47 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 47)", m11.Get_Foo(), m11)
	}
	m11.SetSetSetFoo(11)
	if m11.GetSetSetFoo() != 11 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 11)", m11.GetSetSetFoo(), m11)
	}
	checkNameConsistency(t, m11)
	m12 := hpb.M12_builder{
		Foo:    proto.Int32(1),
		SetFoo: proto.Int32(2),
	}.Build()
	m12.Set_Foo(47)
	if m12.Get_Foo() != 47 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 47)", m12.Get_Foo(), m12)
	}
	m12.Set_SetFoo(11)
	if m12.Get_SetFoo() != 11 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 11)", m12.Get_SetFoo(), m12)
	}
	checkNameConsistency(t, m12)
	m13 := hpb.M13_builder{
		Foo:    proto.Int32(1),
		HasFoo: proto.Int32(2),
	}.Build()
	if !m13.Has_Foo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m13.Has_Foo(), m13)
	}
	if !m13.HasHasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m13.HasHasFoo(), m13)
	}
	checkNameConsistency(t, m13)
	m14 := hpb.M14_builder{
		Foo:       proto.Int32(1),
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
		Foo:    proto.Int32(1),
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
		Foo:      proto.Int32(1),
		ClearFoo: proto.Int32(2),
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
		Foo:           proto.Int32(1),
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
		Foo:      proto.Int32(1),
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
		Foo:      proto.Int32(1),
		WhichFoo: proto.Int32(2),
	}.Build()
	if m19.WhichWhichWhichFoo() != hpb.M19_WhichFoo_case {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected M19_ClearFoo_case)", m19.WhichWhichWhichFoo(), m19)
	}
	checkNameConsistency(t, m19)
	m20 := hpb.M20_builder{
		Foo:           proto.Int32(1),
		WhichWhichFoo: proto.Int32(2),
	}.Build()
	if m20.Which_WhichFoo() != hpb.M20_WhichWhichFoo_case {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected M20_WhichWhichFoo_case)", m20.Which_WhichFoo(), m20)
	}
	checkNameConsistency(t, m20)

}

// TestOpaqueMangling tests the backwards compatible mangling as well
// as new style mangling of fields who clashes with the getters. The
// expected behavior, which is somewhat surprising, is documented in
// the proto test_name_clash_opaque.proto itself.
func TestOpaqueMangling(t *testing.T) {
	m1 := opb.M1_builder{
		Foo:       proto.Int32(1),
		GetFoo:    proto.Int32(2),
		GetGetFoo: proto.Int32(3),
	}.Build()
	if m1.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m1.GetFoo(), m1)
	}
	if m1.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m1.GetGetFoo(), m1)
	}
	if m1.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m1.GetGetGetFoo(), m1)
	}
	checkNameConsistency(t, m1)
	m2 := opb.M2_builder{
		Foo:       proto.Int32(1),
		GetFoo:    proto.Int32(2),
		GetGetFoo: proto.Int32(3),
	}.Build()
	if m2.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m2.GetFoo(), m2)
	}
	if m2.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m2.GetGetFoo(), m2)
	}
	if m2.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m2.GetGetGetFoo(), m2)
	}
	checkNameConsistency(t, m2)
	m3 := opb.M3_builder{
		Foo:       proto.Int32(1),
		GetFoo:    proto.Int32(2),
		GetGetFoo: proto.Int32(3),
	}.Build()
	if m3.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m3.GetFoo(), m3)
	}
	if m3.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m3.GetGetFoo(), m3)
	}
	if m3.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m3.GetGetGetFoo(), m3)
	}
	checkNameConsistency(t, m3)

	m4 := opb.M4_builder{
		GetFoo:       proto.Int32(2),
		GetGetGetFoo: proto.Int32(3),
		Foo:          proto.Int32(1),
	}.Build()
	if m4.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m4.GetFoo(), m4)
	}
	if m4.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m4.GetGetFoo(), m4)
	}
	if !m4.HasGetGetFoo() {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected true)", m4.HasGetGetFoo(), m4)
	}
	if m4.GetGetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_get_foo' has unexpected value %v for %T (expected 3)", m4.GetGetGetGetFoo(), m4)
	}
	checkNameConsistency(t, m4)

	m5 := opb.M5_builder{
		GetFoo:    proto.Int32(2),
		GetGetFoo: proto.Int32(3),
		Foo:       proto.Int32(1),
	}.Build()
	if m5.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m5.GetFoo(), m5)
	}
	if m5.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m5.GetGetFoo(), m5)
	}
	if m5.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m5.GetGetGetFoo(), m5)
	}
	checkNameConsistency(t, m5)

	m6 := opb.M6_builder{
		GetGetGetFoo: proto.Int32(3),
		GetFoo:       proto.Int32(2),
		Foo:          proto.Int32(1),
	}.Build()
	if m6.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m6.GetFoo(), m6)
	}
	if m6.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m6.GetGetFoo(), m6)
	}
	if m6.GetGetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_get_foo' has unexpected value %v for %T (expected 3)", m6.GetGetGetGetFoo(), m6)
	}
	checkNameConsistency(t, m6)

	m7 := opb.M7_builder{
		GetFoo: proto.Int32(3),
		Foo:    proto.Int32(1),
	}.Build()
	if m7.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m7.GetFoo(), m7)
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
		GetFoo:    proto.Int32(2),
		Foo:       proto.Int32(1),
	}.Build()
	if m8.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m8.GetFoo(), m8)
	}
	if m8.GetGetFoo() != 2 {
		t.Errorf("Proto field 'get_foo' has unexpected value %v for %T (expected 2)", m8.GetGetFoo(), m8)
	}
	if m8.GetGetGetFoo() != 3 {
		t.Errorf("Proto field 'get_get_foo' has unexpected value %v for %T (expected 3)", m8.GetGetGetFoo(), m8)
	}
	checkNameConsistency(t, m8)

	m9 := opb.M9_builder{
		GetGetFoo: proto.Int32(3),
		Foo:       proto.Int32(1),
	}.Build()
	if m9.GetFoo() != 1 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 1)", m9.GetFoo(), m9)
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
		Foo:    proto.Int32(1),
		SetFoo: proto.Int32(2),
	}.Build()
	m10.SetFoo(48)
	if m10.GetFoo() != 48 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 48)", m10.GetFoo(), m10)
	}
	m10.SetSetFoo(11)
	if m10.GetSetFoo() != 11 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 11)", m10.GetSetFoo(), m10)
	}
	checkNameConsistency(t, m10)
	m11 := opb.M11_builder{
		Foo:       proto.Int32(1),
		SetSetFoo: proto.Int32(2),
	}.Build()
	m11.SetFoo(48)
	if m11.GetFoo() != 48 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 48)", m11.GetFoo(), m11)
	}
	m11.SetSetSetFoo(11)
	if m11.GetSetSetFoo() != 11 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 11)", m11.GetSetSetFoo(), m11)
	}
	checkNameConsistency(t, m11)
	m12 := opb.M12_builder{
		Foo:    proto.Int32(1),
		SetFoo: proto.Int32(2),
	}.Build()
	m12.SetFoo(48)
	if m12.GetFoo() != 48 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 48)", m12.GetFoo(), m12)
	}
	m12.SetSetFoo(12)
	if m12.GetSetFoo() != 12 {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected 12)", m12.GetSetFoo(), m12)
	}
	checkNameConsistency(t, m12)
	m13 := opb.M13_builder{
		Foo:    proto.Int32(1),
		HasFoo: proto.Int32(2),
	}.Build()
	if !m13.HasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m13.HasFoo(), m13)
	}
	if !m13.HasHasFoo() {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected true)", m13.HasHasFoo(), m13)
	}
	checkNameConsistency(t, m13)
	m14 := opb.M14_builder{
		Foo:       proto.Int32(1),
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
		Foo:    proto.Int32(1),
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
		Foo:      proto.Int32(1),
		ClearFoo: proto.Int32(2),
	}.Build()
	m16.SetFoo(4711)
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
		Foo:           proto.Int32(1),
		ClearClearFoo: proto.Int32(2),
	}.Build()
	m17.SetFoo(4711)
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
		Foo:      proto.Int32(1),
		ClearFoo: proto.Int32(2),
	}.Build()
	m18.SetFoo(4711)
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
		Foo:      proto.Int32(1),
		WhichFoo: proto.Int32(2),
	}.Build()
	if m19.WhichWhichWhichFoo() != opb.M19_WhichFoo_case {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected M19_ClearFoo_case)", m19.WhichWhichWhichFoo(), m19)
	}
	checkNameConsistency(t, m19)
	m20 := opb.M20_builder{
		Foo:           proto.Int32(1),
		WhichWhichFoo: proto.Int32(2),
	}.Build()
	if m20.WhichWhichFoo() != opb.M20_WhichWhichFoo_case {
		t.Errorf("Proto field 'foo' has unexpected value %v for %T (expected M20_WhichWhichFoo_case)", m20.WhichWhichFoo(), m20)
	}
	checkNameConsistency(t, m20)

}

func protogenFor(t *testing.T, m proto.Message) *protogen.Message {
	t.Helper()

	md := m.ProtoReflect().Descriptor()

	// Construct a Protobuf plugin code generation request based on the
	// transitive closure of dependencies of message m.
	req := &pluginpb.CodeGeneratorRequest{
		ProtoFile: []*descpb.FileDescriptorProto{
			protodesc.ToFileDescriptorProto(descpb.File_google_protobuf_descriptor_proto),
			protodesc.ToFileDescriptorProto(gofeaturespb.File_google_protobuf_go_features_proto),
			protodesc.ToFileDescriptorProto(md.ParentFile()),
		},
	}
	plugin, err := protogen.Options{}.New(req)
	if err != nil {
		t.Fatalf("protogen.Options.New: %v", err)
	}
	if got, want := len(plugin.Files), len(req.ProtoFile); got != want {
		t.Fatalf("protogen returned %d plugin.Files entries, expected %d", got, want)
	}
	file := plugin.Files[len(plugin.Files)-1]
	for _, msg := range file.Messages {
		if msg.Desc.FullName() != md.FullName() {
			continue
		}
		return msg
	}
	t.Fatalf("BUG: message %q not found in protogen response", md.FullName())
	return nil
}

// checkNameConsistency will go through the fields (deliberately avoiding
// protoreflect; querying protogen instead), and for each field check that one
// of the two naming schemes is used consistently, so that if you find
// e.g. Has_Foo, the setter will be Set_Foo and not SetFoo. It also checks that
// at least one of the naming schemes apply.
func checkNameConsistency(t *testing.T, m proto.Message) {
	t.Helper()
	// It's wrong to use Go reflection on a Message, but in this
	// case, we're specifically looking at the implementation
	typ := reflect.TypeOf(m)
	// The info we need for one field
	type fi struct {
		name     string
		prefixes []string
	}
	// The method prefixes for different kinds of fields
	repeatedPrefixes := []string{"Get", "Set"}
	oneofPrefixes := []string{"Has", "Clear", "Which"}
	optionalPrefixes := []string{"Get", "Set", "Has", "Clear"}

	fields := []fi{}
	msg := protogenFor(t, m)
	for _, f := range msg.Fields {
		prefixes := optionalPrefixes
		if f.Desc.Cardinality() == genid.Field_CARDINALITY_REPEATED_enum_value {
			prefixes = repeatedPrefixes
		}
		fields = append(fields, fi{name: f.GoName, prefixes: prefixes})
	}
	for _, o := range msg.Oneofs {
		fields = append(fields, fi{name: o.GoName, prefixes: oneofPrefixes})
	}
	if len(fields) == 0 {
		t.Errorf("Message %v checked for consistency has no fields to check", reflect.TypeOf(m))
	}
	// Check method names for all fields
	for _, f := range fields {
		// Remove trailing underscores added by old name mangling algorithm
		for f.name[len(f.name)-1] == '_' {
			f.name = f.name[:len(f.name)-1]
		}
		// Check consistency of either "underscored" methods or "non underscored"
		found := ""
		for _, infix := range []string{"_", ""} {
			for _, prefix := range f.prefixes {
				if m, ok := typ.MethodByName(prefix + infix + f.name); ok {
					found = m.Name
					break
				}
			}
			if found != "" {
				for _, prefix := range f.prefixes {
					if _, ok := typ.MethodByName(prefix + infix + f.name); !ok {
						t.Errorf("Field %s has inconsistent method names - found %s, but not %s", f.name, found, prefix+infix+f.name)
					}
				}
				break
			}
		}
		// If we found neither, something is wrong
		if found == "" {
			t.Errorf("Field %s has neither plain nor underscored methods.", f.name)
		}

	}
}
