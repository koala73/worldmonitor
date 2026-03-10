// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// Tests the opaque builders.
package builder_test

import (
	"testing"

	testhybridpb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_hybrid"
	testopaquepb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_opaque"
	"google.golang.org/protobuf/proto"
)

var enableLazy = proto.UnmarshalOptions{}
var disableLazy = proto.UnmarshalOptions{
	NoLazyDecoding: true,
}

func roundtrip(t *testing.T, m proto.Message, unmarshalOpts proto.UnmarshalOptions) {
	b, err := proto.Marshal(m)
	if err != nil {
		t.Fatalf("unable to Marshal proto: %v", err)
	}
	if err := unmarshalOpts.Unmarshal(b, m); err != nil {
		t.Fatalf("roundtrip: unable to unmarshal proto: %v", err)
	}
}

func TestOpaqueBuilderLazy(t *testing.T) {
	testLazyOptionalBuilder(t, enableLazy)
}

func TestOpaqueBuilderEager(t *testing.T) {
	testLazyOptionalBuilder(t, disableLazy)
}

// testLazyOptionalBuilder exercises all optional fields in the testall_opaque_optional3_go_proto builder
func testLazyOptionalBuilder(t *testing.T, unmarshalOpts proto.UnmarshalOptions) {
	// Create empty proto from builder
	m := testopaquepb.TestAllTypes_builder{}.Build()

	roundtrip(t, m, unmarshalOpts)

	// Check lazy message field
	m = testopaquepb.TestAllTypes_builder{
		OptionalLazyNestedMessage: testopaquepb.TestAllTypes_NestedMessage_builder{
			A: proto.Int32(1147),
		}.Build(),
		RepeatedNestedMessage: []*testopaquepb.TestAllTypes_NestedMessage{
			testopaquepb.TestAllTypes_NestedMessage_builder{
				A: proto.Int32(1247),
			}.Build(),
		},
		OneofNestedMessage: testopaquepb.TestAllTypes_NestedMessage_builder{
			A: proto.Int32(1347),
		}.Build(),
		MapStringNestedMessage: map[string]*testopaquepb.TestAllTypes_NestedMessage{
			"a": testopaquepb.TestAllTypes_NestedMessage_builder{
				A: proto.Int32(5),
			}.Build(),
		},
	}.Build()

	roundtrip(t, m, unmarshalOpts)

	if got, want := m.HasOptionalLazyNestedMessage(), true; got != want {
		t.Errorf("Builder for field NestedMessage did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalLazyNestedMessage().GetA(), int32(1147); got != want {
		t.Errorf("Builder for field NestedMessage did not work, got %v, wanted %v", got, want)
	}
	if got, want := len(m.GetRepeatedNestedMessage()), 1; got != want {
		t.Errorf("Builder for field RepeatedNestedMessage did not set a field of expected length, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedNestedMessage()[0].GetA(), int32(1247); got != want {
		t.Errorf("Builder for field RepetedNestedMessage did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOneofNestedMessage(), true; got != want {
		t.Errorf("Builder for field OneofNestedMessage did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOneofNestedMessage().GetA(), int32(1347); got != want {
		t.Errorf("Builder for field OneofNestedMessage did not work, got %v, wanted %v", got, want)
	}
	// Check map field
	{
		if got, want := len(m.GetMapStringNestedMessage()), 1; got != want {
			t.Errorf("Builder for field MapStringNestedMessage did not work, got len %v, wanted len %v", got, want)
		}
		if got, want := m.GetMapStringNestedMessage()["a"].GetA(), int32(5); got != want {
			t.Errorf("Builder for field MapStringNestedMessage did not work, got %v, wanted %v", got, want)
		}
	}
}

// TestHybridOptionalBuilder exercises all optional fields in the testall_opaque_optional3_go_proto builder
func TestHybridOptionalBuilder(t *testing.T) {
	// Create empty proto from builder
	m := testhybridpb.TestAllTypes_builder{}.Build()

	// Check that no optional fields are present
	// Check presence of each field
	if got, want := m.HasOptionalInt32(), false; got != want {
		t.Errorf("Builder for field OptionalInt32 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalInt64(), false; got != want {
		t.Errorf("Builder for field OptionalInt64 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalUint32(), false; got != want {
		t.Errorf("Builder for field OptionalUint32 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalUint64(), false; got != want {
		t.Errorf("Builder for field OptionalUint64 did not set presence, got %v, wanted %v", got, want)
	}

	if got, want := m.HasOptionalSint32(), false; got != want {
		t.Errorf("Builder for field OptionalSint32 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalSint64(), false; got != want {
		t.Errorf("Builder for field OptionalSint64 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalFixed32(), false; got != want {
		t.Errorf("Builder for field OptionalFixed32 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalFixed64(), false; got != want {
		t.Errorf("Builder for field OptionalFixed64 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalSfixed32(), false; got != want {
		t.Errorf("Builder for field OptionalSfixed32 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalSfixed64(), false; got != want {
		t.Errorf("Builder for field OptionalSfixed64 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalFloat(), false; got != want {
		t.Errorf("Builder for field OptionalFloat did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalDouble(), false; got != want {
		t.Errorf("Builder for field OptionalDouble did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalBool(), false; got != want {
		t.Errorf("Builder for field OptionalBool did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalString(), false; got != want {
		t.Errorf("Builder for field OptionalString did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalBytes(), false; got != want {
		t.Errorf("Builder for field OptionalBytes did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalNestedEnum(), false; got != want {
		t.Errorf("Builder for field OptionalNestedEnum did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalNestedMessage(), false; got != want {
		t.Errorf("Builder for field OptionalNestedMessage did not set presence, got %v, wanted %v", got, want)
	}

	// Create builder with every optional field filled in
	b := testhybridpb.TestAllTypes_builder{
		// Scalar fields (including bytes)
		OptionalInt32:      proto.Int32(3),
		OptionalInt64:      proto.Int64(64),
		OptionalUint32:     proto.Uint32(32),
		OptionalUint64:     proto.Uint64(4711),
		OptionalSint32:     proto.Int32(-23),
		OptionalSint64:     proto.Int64(-123132),
		OptionalFixed32:    proto.Uint32(6798421),
		OptionalFixed64:    proto.Uint64(876555776),
		OptionalSfixed32:   proto.Int32(-909038),
		OptionalSfixed64:   proto.Int64(-63728193629),
		OptionalFloat:      proto.Float32(781.0),
		OptionalDouble:     proto.Float64(-3456.3),
		OptionalBool:       proto.Bool(true),
		OptionalString:     proto.String("hello"),
		OptionalBytes:      []byte("goodbye"),
		OptionalNestedEnum: testhybridpb.TestAllTypes_FOO.Enum(),
		OptionalNestedMessage: testhybridpb.TestAllTypes_NestedMessage_builder{
			A: proto.Int32(1147),
		}.Build(),
	}

	m = b.Build()

	// Check presence of each optional field
	if got, want := m.HasOptionalInt32(), true; got != want {
		t.Errorf("Builder for field OptionalInt32 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalInt64(), true; got != want {
		t.Errorf("Builder for field OptionalInt64 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalUint32(), true; got != want {
		t.Errorf("Builder for field OptionalUint32 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalUint64(), true; got != want {
		t.Errorf("Builder for field OptionalUint64 did not set presence, got %v, wanted %v", got, want)
	}

	if got, want := m.HasOptionalSint32(), true; got != want {
		t.Errorf("Builder for field OptionalSint32 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalSint64(), true; got != want {
		t.Errorf("Builder for field OptionalSint64 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalFixed32(), true; got != want {
		t.Errorf("Builder for field OptionalFixed32 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalFixed64(), true; got != want {
		t.Errorf("Builder for field OptionalFixed64 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalSfixed32(), true; got != want {
		t.Errorf("Builder for field OptionalSfixed32 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalSfixed64(), true; got != want {
		t.Errorf("Builder for field OptionalSfixed64 did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalFloat(), true; got != want {
		t.Errorf("Builder for field OptionalFloat did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalDouble(), true; got != want {
		t.Errorf("Builder for field OptionalDouble did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalBool(), true; got != want {
		t.Errorf("Builder for field OptionalBool did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalString(), true; got != want {
		t.Errorf("Builder for field OptionalString did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalBytes(), true; got != want {
		t.Errorf("Builder for field OptionalBytes did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalNestedEnum(), true; got != want {
		t.Errorf("Builder for field OptionalNestedEnum did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalNestedMessage(), true; got != want {
		t.Errorf("Builder for field OptionalNestedMessage did not set presence, got %v, wanted %v", got, want)
	}

	// Check each optional field against the corresponding field in the builder
	if got, want := m.GetOptionalInt32(), *b.OptionalInt32; got != want {
		t.Errorf("Builder for field OptionalInt32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalInt64(), *b.OptionalInt64; got != want {
		t.Errorf("Builder for field OptionalInt64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalUint32(), *b.OptionalUint32; got != want {
		t.Errorf("Builder for field OptionalUint32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalUint64(), *b.OptionalUint64; got != want {
		t.Errorf("Builder for field OptionalUint64 did not work, got %v, wanted %v", got, want)
	}

	if got, want := m.GetOptionalSint32(), *b.OptionalSint32; got != want {
		t.Errorf("Builder for field OptionalSint32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalSint64(), *b.OptionalSint64; got != want {
		t.Errorf("Builder for field OptionalSint64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalFixed32(), *b.OptionalFixed32; got != want {
		t.Errorf("Builder for field OptionalFixed32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalFixed64(), *b.OptionalFixed64; got != want {
		t.Errorf("Builder for field OptionalFixed64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalSfixed32(), *b.OptionalSfixed32; got != want {
		t.Errorf("Builder for field OptionalSfixed32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalSfixed64(), *b.OptionalSfixed64; got != want {
		t.Errorf("Builder for field OptionalSfixed64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalFloat(), *b.OptionalFloat; got != want {
		t.Errorf("Builder for field OptionalFloat did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalDouble(), *b.OptionalDouble; got != want {
		t.Errorf("Builder for field OptionalDouble did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalBool(), *b.OptionalBool; got != want {
		t.Errorf("Builder for field OptionalBool did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalString(), *b.OptionalString; got != want {
		t.Errorf("Builder for field OptionalString did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalBytes(), b.OptionalBytes; string(got) != string(want) {
		t.Errorf("Builder for field OptionalBytes did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalNestedEnum(), *b.OptionalNestedEnum; got != want {
		t.Errorf("Builder for field OptionalNestedEnum did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalNestedMessage().GetA(), int32(1147); got != want {
		t.Errorf("Builder for field OptionalNestedMessage did not work, got %v, wanted %v", got, want)
	}

}

// TestOpaqueBuilder exercises all non-oneof fields in the testall_opaque3_go_proto builder
func TestOpaqueBuilder(t *testing.T) {
	// Create builder with every possible field filled in
	b := testopaquepb.TestAllTypes_builder{
		// Scalar fields (including bytes)
		SingularInt32:      3,
		SingularInt64:      64,
		SingularUint32:     32,
		SingularUint64:     4711,
		SingularSint32:     -23,
		SingularSint64:     -123132,
		SingularFixed32:    6798421,
		SingularFixed64:    876555776,
		SingularSfixed32:   -909038,
		SingularSfixed64:   -63728193629,
		SingularFloat:      781.0,
		SingularDouble:     -3456.3,
		SingularBool:       true,
		SingularString:     "hello",
		SingularBytes:      []byte("goodbye"),
		OptionalNestedEnum: testopaquepb.TestAllTypes_FOO.Enum(),
		OptionalNestedMessage: testopaquepb.TestAllTypes_NestedMessage_builder{
			A: proto.Int32(1147),
		}.Build(),
		RepeatedInt32:      []int32{4},
		RepeatedInt64:      []int64{65},
		RepeatedUint32:     []uint32{33},
		RepeatedUint64:     []uint64{4712},
		RepeatedSint32:     []int32{-24},
		RepeatedSint64:     []int64{-123133},
		RepeatedFixed32:    []uint32{6798422},
		RepeatedFixed64:    []uint64{876555777},
		RepeatedSfixed32:   []int32{-909039},
		RepeatedSfixed64:   []int64{-63728193630},
		RepeatedFloat:      []float32{782.0},
		RepeatedDouble:     []float64{-3457.3},
		RepeatedBool:       []bool{false},
		RepeatedString:     []string{"hello!"},
		RepeatedBytes:      [][]byte{[]byte("goodbye!")},
		RepeatedNestedEnum: []testopaquepb.TestAllTypes_NestedEnum{testopaquepb.TestAllTypes_BAZ},
		RepeatedNestedMessage: []*testopaquepb.TestAllTypes_NestedMessage{testopaquepb.TestAllTypes_NestedMessage_builder{
			A: proto.Int32(1148),
		}.Build()},
		MapInt32Int32: map[int32]int32{
			89: 87,
			87: 89,
		},
		MapInt64Int64: map[int64]int64{
			345:  678,
			2121: 5432,
		},
		MapUint32Uint32: map[uint32]uint32{
			765476: 87658,
			4324:   6543,
		},
		MapUint64Uint64: map[uint64]uint64{
			2324:    543534,
			7657654: 675,
		},
		MapSint32Sint32: map[int32]int32{
			-45243: -543353,
			-54343: -33,
		},
		MapSint64Sint64: map[int64]int64{
			-6754389: 34,
			467382:   -676743,
		},
		MapFixed32Fixed32: map[uint32]uint32{
			43432:   4444,
			5555555: 666666,
		},
		MapFixed64Fixed64: map[uint64]uint64{
			777777: 888888,
			999999: 111111,
		},
		MapSfixed32Sfixed32: map[int32]int32{
			-778989: -543,
			-9999:   98765,
		},
		MapSfixed64Sfixed64: map[int64]int64{
			65486723:  89,
			-76843592: -33,
		},
		MapInt32Float: map[int32]float32{
			543433:  7.5,
			3434333: 3.14,
		},
		MapInt32Double: map[int32]float64{
			876876: 34.34,
			987650: 35.35,
		},
		MapBoolBool: map[bool]bool{
			true:  true,
			false: true,
		},
		MapStringString: map[string]string{
			"hello?": "goodbye?",
			"hi":     "bye",
		},
		MapStringBytes: map[string][]byte{
			"hi?":  []byte("bye!"),
			"bye?": []byte("hi!"),
		},
		MapStringNestedMessage: map[string]*testopaquepb.TestAllTypes_NestedMessage{
			"nest": testopaquepb.TestAllTypes_NestedMessage_builder{
				A: proto.Int32(99),
			}.Build(),
			"mess": testopaquepb.TestAllTypes_NestedMessage_builder{
				A: proto.Int32(100),
			}.Build(),
		},
		MapStringNestedEnum: map[string]testopaquepb.TestAllTypes_NestedEnum{
			"bar": testopaquepb.TestAllTypes_BAR,
			"baz": testopaquepb.TestAllTypes_BAZ,
		},
		OneofUint32: proto.Uint32(77665544),
	}
	m := b.Build()

	// Check each field against the corresponding field in the builder
	if got, want := m.GetSingularInt32(), b.SingularInt32; got != want {
		t.Errorf("Builder for field FInt32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularInt64(), b.SingularInt64; got != want {
		t.Errorf("Builder for field FInt64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularUint32(), b.SingularUint32; got != want {
		t.Errorf("Builder for field FUint32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularUint64(), b.SingularUint64; got != want {
		t.Errorf("Builder for field FUint64 did not work, got %v, wanted %v", got, want)
	}

	if got, want := m.GetSingularSint32(), b.SingularSint32; got != want {
		t.Errorf("Builder for field FSint32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularSint64(), b.SingularSint64; got != want {
		t.Errorf("Builder for field FSint64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularFixed32(), b.SingularFixed32; got != want {
		t.Errorf("Builder for field FFixed32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularFixed64(), b.SingularFixed64; got != want {
		t.Errorf("Builder for field FFixed64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularSfixed32(), b.SingularSfixed32; got != want {
		t.Errorf("Builder for field FSfixed32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularSfixed64(), b.SingularSfixed64; got != want {
		t.Errorf("Builder for field FSfixed64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularFloat(), b.SingularFloat; got != want {
		t.Errorf("Builder for field FFloat did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularDouble(), b.SingularDouble; got != want {
		t.Errorf("Builder for field FDouble did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularBool(), b.SingularBool; got != want {
		t.Errorf("Builder for field FBool did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularString(), b.SingularString; got != want {
		t.Errorf("Builder for field FString did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetSingularBytes(), b.SingularBytes; string(got) != string(want) {
		t.Errorf("Builder for field FBytes did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalNestedEnum(), *b.OptionalNestedEnum; got != want {
		t.Errorf("Builder for field FNestedEnum did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.HasOptionalNestedMessage(), true; got != want {
		t.Errorf("Builder for field FNestedMessage did not set presence, got %v, wanted %v", got, want)
	}
	if got, want := m.GetOptionalNestedMessage().GetA(), int32(1147); got != want {
		t.Errorf("Builder for field FNestedMessage did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedInt32()[0], b.RepeatedInt32[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedInt32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedInt64()[0], b.RepeatedInt64[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedInt64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedUint32()[0], b.RepeatedUint32[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedUint32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedUint64()[0], b.RepeatedUint64[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedUint64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedSint32()[0], b.RepeatedSint32[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedSint32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedSint64()[0], b.RepeatedSint64[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedSint64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedFixed32()[0], b.RepeatedFixed32[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedFixed32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedFixed64()[0], b.RepeatedFixed64[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedFixed64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedSfixed32()[0], b.RepeatedSfixed32[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedSfixed32 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedSfixed64()[0], b.RepeatedSfixed64[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedSfixed64 did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedFloat()[0], b.RepeatedFloat[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedFloat did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedDouble()[0], b.RepeatedDouble[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedDouble did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedBool()[0], b.RepeatedBool[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedBool did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedString()[0], b.RepeatedString[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedString did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedBytes()[0], b.RepeatedBytes[0]; string(got) != string(want) {
		t.Errorf("Builder for repeated field RepeatedBytes did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedNestedEnum()[0], b.RepeatedNestedEnum[0]; got != want {
		t.Errorf("Builder for repeated field RepeatedNestedEnum did not work, got %v, wanted %v", got, want)
	}
	if got, want := m.GetRepeatedNestedMessage()[0].GetA(), int32(1148); got != want {
		t.Errorf("Builder for repeated field RepeatedNestedMessage did not work, got %v, wanted %v", got, want)
	}

	for key, want := range b.MapInt32Int32 {
		if got := m.GetMapInt32Int32()[key]; got != want {
			t.Errorf("Builder for map field MapInt32Int32[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}

	for key, want := range b.MapInt64Int64 {
		if got := m.GetMapInt64Int64()[key]; got != want {
			t.Errorf("Builder for map field MapInt64Int64[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapUint32Uint32 {
		if got := m.GetMapUint32Uint32()[key]; got != want {
			t.Errorf("Builder for map field MapUint32Uint32[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapUint64Uint64 {
		if got := m.GetMapUint64Uint64()[key]; got != want {
			t.Errorf("Builder for map field MapUint64Uint64[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapSint32Sint32 {
		if got := m.GetMapSint32Sint32()[key]; got != want {
			t.Errorf("Builder for map field MapSint32Sint32[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapSint64Sint64 {
		if got := m.GetMapSint64Sint64()[key]; got != want {
			t.Errorf("Builder for map field MapSint64Sint64[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapFixed32Fixed32 {
		if got := m.GetMapFixed32Fixed32()[key]; got != want {
			t.Errorf("Builder for map field MapFixed32Fixed32[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapFixed64Fixed64 {
		if got := m.GetMapFixed64Fixed64()[key]; got != want {
			t.Errorf("Builder for map field MapFixed64Fixed64[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapSfixed32Sfixed32 {
		if got := m.GetMapSfixed32Sfixed32()[key]; got != want {
			t.Errorf("Builder for map field MapSfixed32Sfixed32[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapSfixed64Sfixed64 {
		if got := m.GetMapSfixed64Sfixed64()[key]; got != want {
			t.Errorf("Builder for map field MapSfixed64Sfixed64[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapInt32Float {
		if got := m.GetMapInt32Float()[key]; got != want {
			t.Errorf("Builder for map field MapInt32Float[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapInt32Double {
		if got := m.GetMapInt32Double()[key]; got != want {
			t.Errorf("Builder for map field MapInt32Double[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapBoolBool {
		if got := m.GetMapBoolBool()[key]; got != want {
			t.Errorf("Builder for map field MapBoolBool[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapStringString {
		if got := m.GetMapStringString()[key]; got != want {
			t.Errorf("Builder for map field MapStringString[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapStringBytes {
		if got := m.GetMapStringBytes()[key]; string(got) != string(want) {
			t.Errorf("Builder for map field MapStringBytes[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapStringNestedMessage {
		if got := m.GetMapStringNestedMessage()[key]; got.GetA() != want.GetA() {
			t.Errorf("Builder for map field MapStringNestedMessage[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	for key, want := range b.MapStringNestedEnum {
		if got := m.GetMapStringNestedEnum()[key]; got != want {
			t.Errorf("Builder for map field MapStringNestedEnum[%v] did not work, got %v, wanted %v", key, got, want)
		}
	}
	if got, want := m.GetOneofUint32(), *b.OneofUint32; got != want {
		t.Errorf("Builder for field OneofUint32 did not work, got %v, wanted %v", got, want)
	}
}

func TestOpaqueBuilderOneofsLazy(t *testing.T) {
	testOpaqueBuilderOneofs(t, enableLazy)
}

func TestOpaqueBuilderOneofsEager(t *testing.T) {
	testOpaqueBuilderOneofs(t, disableLazy)
}

// TestOpaqueBuilderOneofs test each oneof option in the builder separately
func testOpaqueBuilderOneofs(t *testing.T, unmarshalOpts proto.UnmarshalOptions) {
	for _, task := range []struct {
		set   func() (any, int, *testopaquepb.TestAllTypes)
		check func(any, *testopaquepb.TestAllTypes) (bool, any)
	}{
		{
			// uint32
			set: func() (any, int, *testopaquepb.TestAllTypes) {
				val := uint32(6754)
				return val, int(testopaquepb.TestAllTypes_OneofUint32_case), testopaquepb.TestAllTypes_builder{OneofUint32: &val}.Build()
			},
			check: func(x any, m *testopaquepb.TestAllTypes) (bool, any) {
				want := x.(uint32)
				got := m.GetOneofUint32()
				return want == got, got
			},
		},
		{
			// message
			set: func() (any, int, *testopaquepb.TestAllTypes) {
				val := testopaquepb.TestAllTypes_NestedMessage_builder{A: proto.Int32(5432678)}.Build()
				return val, int(testopaquepb.TestAllTypes_OneofNestedMessage_case), testopaquepb.TestAllTypes_builder{OneofNestedMessage: val}.Build()
			},
			check: func(x any, m *testopaquepb.TestAllTypes) (bool, any) {
				want := x.(*testopaquepb.TestAllTypes_NestedMessage)
				got := m.GetOneofNestedMessage()
				return want.GetA() == got.GetA(), got
			},
		},
		{
			// string
			set: func() (any, int, *testopaquepb.TestAllTypes) {
				val := "random"
				return val, int(testopaquepb.TestAllTypes_OneofString_case), testopaquepb.TestAllTypes_builder{OneofString: &val}.Build()
			},
			check: func(x any, m *testopaquepb.TestAllTypes) (bool, any) {
				want := x.(string)
				got := m.GetOneofString()
				return want == got, got
			},
		},
		{
			// bytes
			set: func() (any, int, *testopaquepb.TestAllTypes) {
				val := []byte("randombytes")
				return val, int(testopaquepb.TestAllTypes_OneofBytes_case), testopaquepb.TestAllTypes_builder{OneofBytes: val}.Build()
			},
			check: func(x any, m *testopaquepb.TestAllTypes) (bool, any) {
				want := x.([]byte)
				got := m.GetOneofBytes()
				return string(want) == string(got), got
			},
		},
		{
			// uint64
			set: func() (any, int, *testopaquepb.TestAllTypes) {
				val := uint64(65934287653)
				return val, int(testopaquepb.TestAllTypes_OneofUint64_case), testopaquepb.TestAllTypes_builder{OneofUint64: &val}.Build()
			},
			check: func(x any, m *testopaquepb.TestAllTypes) (bool, any) {
				want := x.(uint64)
				got := m.GetOneofUint64()
				return want == got, got
			},
		},
		{
			// bool
			set: func() (any, int, *testopaquepb.TestAllTypes) {
				val := true
				return val, int(testopaquepb.TestAllTypes_OneofBool_case), testopaquepb.TestAllTypes_builder{OneofBool: &val}.Build()
			},
			check: func(x any, m *testopaquepb.TestAllTypes) (bool, any) {
				want := x.(bool)
				got := m.GetOneofBool()
				return want == got, got
			},
		},
		{
			// float
			set: func() (any, int, *testopaquepb.TestAllTypes) {
				val := float32(-54.45)
				return val, int(testopaquepb.TestAllTypes_OneofFloat_case), testopaquepb.TestAllTypes_builder{OneofFloat: &val}.Build()
			},
			check: func(x any, m *testopaquepb.TestAllTypes) (bool, any) {
				want := x.(float32)
				got := m.GetOneofFloat()
				return want == got, got
			},
		},
		{
			// double
			set: func() (any, int, *testopaquepb.TestAllTypes) {
				val := float64(-45.54)
				return val, int(testopaquepb.TestAllTypes_OneofDouble_case), testopaquepb.TestAllTypes_builder{OneofDouble: &val}.Build()
			},
			check: func(x any, m *testopaquepb.TestAllTypes) (bool, any) {
				want := x.(float64)
				got := m.GetOneofDouble()
				return want == got, got
			},
		},
		{
			// enum
			set: func() (any, int, *testopaquepb.TestAllTypes) {
				val := testopaquepb.TestAllTypes_BAR
				return val, int(testopaquepb.TestAllTypes_OneofEnum_case), testopaquepb.TestAllTypes_builder{OneofEnum: &val}.Build()
			},
			check: func(x any, m *testopaquepb.TestAllTypes) (bool, any) {
				want := x.(testopaquepb.TestAllTypes_NestedEnum)
				got := m.GetOneofEnum()
				return want == got, got
			},
		},
	} {
		want, cas, m := task.set()
		gotCase := int(m.WhichOneofField())
		if gotCase != cas {
			t.Errorf("Builder did not make which function return correct value, got %v, wanted %v for type %T", gotCase, cas, want)
		}
		ok, got := task.check(want, m)
		if !ok {
			t.Errorf("Builder did not set oneof field correctly, got %v, wanted %v for type %T", got, want, want)
		}
	}
}
