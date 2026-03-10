// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package proto_test

import (
	"testing"

	test3openpb "google.golang.org/protobuf/internal/testprotos/test3"
	test3hybridpb "google.golang.org/protobuf/internal/testprotos/test3/test3_hybrid"
	test3opaquepb "google.golang.org/protobuf/internal/testprotos/test3/test3_opaque"
	testhybridpb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_hybrid"
	testopaquepb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_opaque"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

func TestOpenWhich(t *testing.T) {
	var x *testhybridpb.TestAllTypes
	if x.WhichOneofField() != 0 {
		t.Errorf("WhichOneofField on nil returned %d, expected %d", x.WhichOneofField(), 0)
	}
	x = &testhybridpb.TestAllTypes{}
	if x.WhichOneofField() != 0 {
		t.Errorf("WhichOneofField returned %d, expected %d", x.WhichOneofField(), 0)
	}
	tab := []struct {
		m *testhybridpb.TestAllTypes
		v protoreflect.FieldNumber
	}{
		{
			m: testhybridpb.TestAllTypes_builder{
				OneofUint32: proto.Uint32(46),
			}.Build(),
			v: protoreflect.FieldNumber(testhybridpb.TestAllTypes_OneofUint32_case),
		},
		{
			m: testhybridpb.TestAllTypes_builder{
				OneofNestedMessage: testhybridpb.TestAllTypes_NestedMessage_builder{A: proto.Int32(46)}.Build(),
			}.Build(),
			v: protoreflect.FieldNumber(testhybridpb.TestAllTypes_OneofNestedMessage_case),
		},
		{
			m: testhybridpb.TestAllTypes_builder{
				OneofString: proto.String("foo"),
			}.Build(),
			v: protoreflect.FieldNumber(testhybridpb.TestAllTypes_OneofString_case),
		},
		{
			m: testhybridpb.TestAllTypes_builder{
				OneofBytes: []byte("foo"),
			}.Build(),
			v: protoreflect.FieldNumber(testhybridpb.TestAllTypes_OneofBytes_case),
		},
		{
			m: testhybridpb.TestAllTypes_builder{
				OneofBool: proto.Bool(true),
			}.Build(),
			v: protoreflect.FieldNumber(testhybridpb.TestAllTypes_OneofBool_case),
		},
		{
			m: testhybridpb.TestAllTypes_builder{
				OneofUint64: proto.Uint64(0),
			}.Build(),
			v: protoreflect.FieldNumber(testhybridpb.TestAllTypes_OneofUint64_case),
		},
		{
			m: testhybridpb.TestAllTypes_builder{
				OneofFloat: proto.Float32(0.0),
			}.Build(),
			v: protoreflect.FieldNumber(testhybridpb.TestAllTypes_OneofFloat_case),
		},
		{
			m: testhybridpb.TestAllTypes_builder{
				OneofDouble: proto.Float64(1.1),
			}.Build(),
			v: protoreflect.FieldNumber(testhybridpb.TestAllTypes_OneofDouble_case),
		},
		{
			m: testhybridpb.TestAllTypes_builder{
				OneofEnum: testhybridpb.TestAllTypes_BAZ.Enum(),
			}.Build(),
			v: protoreflect.FieldNumber(testhybridpb.TestAllTypes_OneofEnum_case),
		},
	}

	for _, mv := range tab {
		if protoreflect.FieldNumber(mv.m.WhichOneofField()) != mv.v {
			t.Errorf("WhichOneofField returned %d, expected %d", mv.m.WhichOneofField(), mv.v)
		}
		if !mv.m.HasOneofField() {
			t.Errorf("HasOneofField returned %t, expected true", mv.m.HasOneofField())

		}
		mv.m.ClearOneofField()
		if mv.m.WhichOneofField() != 0 {
			t.Errorf("WhichOneofField returned %d, expected %d", mv.m.WhichOneofField(), 0)
		}
		if mv.m.HasOneofField() {
			t.Errorf("HasOneofField returned %t, expected false", mv.m.HasOneofField())
		}
	}
}

func TestOpaqueWhich(t *testing.T) {
	var x *testopaquepb.TestAllTypes
	if x.WhichOneofField() != 0 {
		t.Errorf("WhichOneofField on nil returned %d, expected %d", x.WhichOneofField(), 0)
	}
	x = &testopaquepb.TestAllTypes{}
	if x.WhichOneofField() != 0 {
		t.Errorf("WhichOneofField returned %d, expected %d", x.WhichOneofField(), 0)
	}
	en := testopaquepb.TestAllTypes_BAZ
	tab := []struct {
		m *testopaquepb.TestAllTypes
		v protoreflect.FieldNumber
	}{
		{
			m: testopaquepb.TestAllTypes_builder{
				OneofUint32: proto.Uint32(46),
			}.Build(),
			v: protoreflect.FieldNumber(testopaquepb.TestAllTypes_OneofUint32_case),
		},
		{
			m: testopaquepb.TestAllTypes_builder{
				OneofNestedMessage: testopaquepb.TestAllTypes_NestedMessage_builder{A: proto.Int32(46)}.Build(),
			}.Build(),
			v: protoreflect.FieldNumber(testopaquepb.TestAllTypes_OneofNestedMessage_case),
		},
		{
			m: testopaquepb.TestAllTypes_builder{
				OneofString: proto.String("foo"),
			}.Build(),
			v: protoreflect.FieldNumber(testopaquepb.TestAllTypes_OneofString_case),
		},
		{
			m: testopaquepb.TestAllTypes_builder{
				OneofBytes: []byte("foo"),
			}.Build(),
			v: protoreflect.FieldNumber(testopaquepb.TestAllTypes_OneofBytes_case),
		},
		{
			m: testopaquepb.TestAllTypes_builder{
				OneofBool: proto.Bool(true),
			}.Build(),
			v: protoreflect.FieldNumber(testopaquepb.TestAllTypes_OneofBool_case),
		},
		{
			m: testopaquepb.TestAllTypes_builder{
				OneofUint64: proto.Uint64(0),
			}.Build(),
			v: protoreflect.FieldNumber(testopaquepb.TestAllTypes_OneofUint64_case),
		},
		{
			m: testopaquepb.TestAllTypes_builder{
				OneofFloat: proto.Float32(0.0),
			}.Build(),
			v: protoreflect.FieldNumber(testopaquepb.TestAllTypes_OneofFloat_case),
		},
		{
			m: testopaquepb.TestAllTypes_builder{
				OneofDouble: proto.Float64(1.1),
			}.Build(),
			v: protoreflect.FieldNumber(testopaquepb.TestAllTypes_OneofDouble_case),
		},
		{
			m: testopaquepb.TestAllTypes_builder{
				OneofEnum: &en,
			}.Build(),
			v: protoreflect.FieldNumber(testopaquepb.TestAllTypes_OneofEnum_case),
		},
	}

	for _, mv := range tab {
		if protoreflect.FieldNumber(mv.m.WhichOneofField()) != mv.v {
			t.Errorf("WhichOneofField returned %d, expected %d", mv.m.WhichOneofField(), mv.v)
		}
		if !mv.m.HasOneofField() {
			t.Errorf("HasOneofField returned %t, expected true", mv.m.HasOneofField())

		}
		mv.m.ClearOneofField()
		if mv.m.WhichOneofField() != 0 {
			t.Errorf("WhichOneofField returned %d, expected %d", mv.m.WhichOneofField(), 0)
		}
		if mv.m.HasOneofField() {
			t.Errorf("HasOneofField returned %t, expected false", mv.m.HasOneofField())
		}
	}
}

func TestSyntheticOneofOpen(t *testing.T) {
	msg := test3openpb.TestAllTypes{}
	md := msg.ProtoReflect().Descriptor()
	ood := md.Oneofs().ByName("_optional_int32")
	if ood == nil {
		t.Fatal("failed to find oneof _optional_int32")
	}
	if !ood.IsSynthetic() {
		t.Fatal("oneof _optional_int32 should be synthetic")
	}
	if msg.ProtoReflect().WhichOneof(ood) != nil {
		t.Error("oneof _optional_int32 should not have a field set yet")
	}
	msg.OptionalInt32 = proto.Int32(123)
	if msg.ProtoReflect().WhichOneof(ood) == nil {
		t.Error("oneof _optional_int32 should have a field set")
	}
}

func TestSyntheticOneofHybrid(t *testing.T) {
	msg := test3hybridpb.TestAllTypes{}
	md := msg.ProtoReflect().Descriptor()
	ood := md.Oneofs().ByName("_optional_int32")
	if ood == nil {
		t.Fatal("failed to find oneof _optional_int32")
	}
	if !ood.IsSynthetic() {
		t.Fatal("oneof _optional_int32 should be synthetic")
	}
	if msg.ProtoReflect().WhichOneof(ood) != nil {
		t.Error("oneof _optional_int32 should not have a field set yet")
	}
	msg.OptionalInt32 = proto.Int32(123)
	if msg.ProtoReflect().WhichOneof(ood) == nil {
		t.Error("oneof _optional_int32 should have a field set")
	}
}

func TestSyntheticOneofOpaque(t *testing.T) {
	msg := test3opaquepb.TestAllTypes{}
	md := msg.ProtoReflect().Descriptor()
	ood := md.Oneofs().ByName("_optional_int32")
	if ood == nil {
		t.Fatal("failed to find oneof _optional_int32")
	}
	if !ood.IsSynthetic() {
		t.Fatal("oneof _optional_int32 should be synthetic")
	}
	if msg.ProtoReflect().WhichOneof(ood) != nil {
		t.Error("oneof _optional_int32 should not have a field set yet")
	}
	msg.SetOptionalInt32(123)
	if msg.ProtoReflect().WhichOneof(ood) == nil {
		t.Error("oneof _optional_int32 should have a field set")
	}
}
