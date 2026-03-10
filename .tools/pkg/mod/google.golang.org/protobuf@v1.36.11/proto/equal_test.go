// Copyright 2019 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package proto_test

import (
	"fmt"
	"math"
	"testing"

	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/internal/pragma"
	"google.golang.org/protobuf/internal/protobuild"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/testing/protopack"

	testpb "google.golang.org/protobuf/internal/testprotos/test"
	test3pb "google.golang.org/protobuf/internal/testprotos/test3"
	testeditionspb "google.golang.org/protobuf/internal/testprotos/testeditions"
)

func TestEqual(t *testing.T) {
	identicalPtrPb := &testpb.TestAllTypes{MapStringString: map[string]string{"a": "b", "c": "d"}}

	type incomparableMessage struct {
		*testpb.TestAllTypes
		pragma.DoNotCompare
	}

	type test struct {
		desc string
		x, y proto.Message
		eq   bool
	}
	tests := []test{
		{
			x:  nil,
			y:  nil,
			eq: true,
		}, {
			x:  (*testpb.TestAllTypes)(nil),
			y:  nil,
			eq: false,
		}, {
			x:  (*testpb.TestAllTypes)(nil),
			y:  (*testpb.TestAllTypes)(nil),
			eq: true,
		}, {
			x:  new(testpb.TestAllTypes),
			y:  (*testpb.TestAllTypes)(nil),
			eq: false,
		}, {
			x:  new(testpb.TestAllTypes),
			y:  new(testpb.TestAllTypes),
			eq: true,
		}, {
			x:  (*testpb.TestAllTypes)(nil),
			y:  (*testpb.TestAllExtensions)(nil),
			eq: false,
		}, {
			x:  (*testpb.TestAllTypes)(nil),
			y:  new(testpb.TestAllExtensions),
			eq: false,
		}, {
			x:  new(testpb.TestAllTypes),
			y:  new(testpb.TestAllExtensions),
			eq: false,
		},

		// Identical input pointers
		{
			x:  identicalPtrPb,
			y:  identicalPtrPb,
			eq: true,
		},

		// Incomparable types. The top-level types are not actually directly
		// compared (which would panic), but rather the comparison happens on the
		// objects returned by ProtoReflect(). These tests are here just to ensure
		// that any short-circuit checks do not accidentally try to compare
		// incomparable top-level types.
		{
			x:  incomparableMessage{TestAllTypes: identicalPtrPb},
			y:  incomparableMessage{TestAllTypes: identicalPtrPb},
			eq: true,
		},
		{
			x:  identicalPtrPb,
			y:  incomparableMessage{TestAllTypes: identicalPtrPb},
			eq: true,
		},
		{
			x:  identicalPtrPb,
			y:  &incomparableMessage{TestAllTypes: identicalPtrPb},
			eq: true,
		},
	}

	type xy struct {
		X proto.Message
		Y proto.Message
	}
	cloneAll := func(in []proto.Message) []proto.Message {
		out := make([]proto.Message, len(in))
		for idx, msg := range in {
			out[idx] = proto.Clone(msg)
		}
		return out
	}
	makeXY := func(x protobuild.Message, y protobuild.Message, messages ...proto.Message) []xy {
		xs := makeMessages(x, cloneAll(messages)...)
		ys := makeMessages(y, cloneAll(messages)...)
		result := make([]xy, len(xs))
		for idx := range xs {
			result[idx] = xy{
				X: xs[idx],
				Y: ys[idx],
			}
		}
		return result
	}
	makeTest := func(tmpl test, msgs []xy) []test {
		result := make([]test, 0, len(msgs))
		for _, msg := range msgs {
			tmpl.x = msg.X
			tmpl.y = msg.Y
			result = append(result, tmpl)
		}
		return result
	}

	// Scalars.

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_int32": 1},
		protobuild.Message{"optional_int32": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_int64": 1},
		protobuild.Message{"optional_int64": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_uint32": 1},
		protobuild.Message{"optional_uint32": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_uint64": 1},
		protobuild.Message{"optional_uint64": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_sint32": 1},
		protobuild.Message{"optional_sint32": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_sint64": 1},
		protobuild.Message{"optional_sint64": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_fixed32": 1},
		protobuild.Message{"optional_fixed32": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_fixed64": 1},
		protobuild.Message{"optional_fixed64": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_sfixed32": 1},
		protobuild.Message{"optional_sfixed32": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_sfixed64": 1},
		protobuild.Message{"optional_sfixed64": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_float": 1},
		protobuild.Message{"optional_float": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_double": 1},
		protobuild.Message{"optional_double": 2},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_float": math.NaN()},
		protobuild.Message{"optional_float": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_double": math.NaN()},
		protobuild.Message{"optional_double": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_bool": true},
		protobuild.Message{"optional_bool": false},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_string": "a"},
		protobuild.Message{"optional_string": "b"},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_bytes": []byte("a")},
		protobuild.Message{"optional_bytes": []byte("b")},
	))...)

	tests = append(tests, makeTest(test{desc: "Scalars"}, makeXY(
		protobuild.Message{"optional_nested_enum": "FOO"},
		protobuild.Message{"optional_nested_enum": "BAR"},
	))...)

	// Scalars (equal).

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_int32": 2},
		protobuild.Message{"optional_int32": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_int64": 2},
		protobuild.Message{"optional_int64": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_uint32": 2},
		protobuild.Message{"optional_uint32": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_uint64": 2},
		protobuild.Message{"optional_uint64": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_sint32": 2},
		protobuild.Message{"optional_sint32": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_sint64": 2},
		protobuild.Message{"optional_sint64": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_fixed32": 2},
		protobuild.Message{"optional_fixed32": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_fixed64": 2},
		protobuild.Message{"optional_fixed64": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_sfixed32": 2},
		protobuild.Message{"optional_sfixed32": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_sfixed64": 2},
		protobuild.Message{"optional_sfixed64": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_float": 2},
		protobuild.Message{"optional_float": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_double": 2},
		protobuild.Message{"optional_double": 2},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_float": math.NaN()},
		protobuild.Message{"optional_float": math.NaN()},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_double": math.NaN()},
		protobuild.Message{"optional_double": math.NaN()},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_bool": true},
		protobuild.Message{"optional_bool": true},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_string": "abc"},
		protobuild.Message{"optional_string": "abc"},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_bytes": []byte("abc")},
		protobuild.Message{"optional_bytes": []byte("abc")},
	))...)

	tests = append(tests, makeTest(test{
		desc: "Scalars",
		eq:   true,
	}, makeXY(
		protobuild.Message{"optional_nested_enum": "FOO"},
		protobuild.Message{"optional_nested_enum": "FOO"},
	))...)

	// Presence.

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_int32": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_int64": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_uint32": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_uint64": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_sint32": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_sint64": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_fixed32": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_fixed64": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_sfixed32": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_sfixed64": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_float": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_double": 0},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_bool": false},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_string": ""},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_bytes": []byte{}},
	))...)

	tests = append(tests, makeTest(test{desc: "Presence"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_nested_enum": "FOO"},
	))...)

	// Proto2 default values are not considered by Equal, so the following are still unequal.

	allTypesNoProto3 := []proto.Message{
		&testpb.TestAllTypes{},
		// test3pb.TestAllTypes is intentionally missing:
		// proto3 does not support default values.
		// proto3 does not support groups.
		&testpb.TestAllExtensions{},
		&testeditionspb.TestAllTypes{},
	}

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{"default_int32": 81},
		protobuild.Message{},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_int32": 81},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_int64": 82},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_uint32": 83},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_uint64": 84},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_sint32": -85},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_sint64": 86},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_fixed32": 87},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_fixed64": 87},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_sfixed32": 89},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_sfixed64": -90},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_float": 91.5},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_double": 92e3},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_bool": true},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_string": "hello"},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_bytes": []byte("world")},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Default"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"default_nested_enum": "BAR"},
		&testpb.TestAllTypes{},
		// test3pb.TestAllTypes is intentionally missing:
		// proto3 does not support default values.
		// testpb.TestAllExtensions is intentionally missing:
		// extensions cannot declare nested enums.
		&testeditionspb.TestAllTypes{},
	))...)

	// Groups.

	tests = append(tests, makeTest(test{desc: "Groups"}, makeXY(
		protobuild.Message{"optionalgroup": protobuild.Message{
			"a": 1,
		}},
		protobuild.Message{"optionalgroup": protobuild.Message{
			"a": 2,
		}},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Groups"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optionalgroup": protobuild.Message{}},
		allTypesNoProto3...,
	))...)

	// Messages.

	tests = append(tests, makeTest(test{desc: "Messages"}, makeXY(
		protobuild.Message{"optional_nested_message": protobuild.Message{
			"a": 1,
		}},
		protobuild.Message{"optional_nested_message": protobuild.Message{
			"a": 2,
		}},
	))...)

	tests = append(tests, makeTest(test{desc: "Messages"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_nested_message": protobuild.Message{}},
	))...)

	// Lists.

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_int32": []int32{1}},
		protobuild.Message{"repeated_int32": []int32{1, 2}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_int32": []int32{1, 2}},
		protobuild.Message{"repeated_int32": []int32{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_int64": []int64{1, 2}},
		protobuild.Message{"repeated_int64": []int64{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_uint32": []uint32{1, 2}},
		protobuild.Message{"repeated_uint32": []uint32{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_uint64": []uint64{1, 2}},
		protobuild.Message{"repeated_uint64": []uint64{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_sint32": []int32{1, 2}},
		protobuild.Message{"repeated_sint32": []int32{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_sint64": []int64{1, 2}},
		protobuild.Message{"repeated_sint64": []int64{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_fixed32": []uint32{1, 2}},
		protobuild.Message{"repeated_fixed32": []uint32{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_fixed64": []uint64{1, 2}},
		protobuild.Message{"repeated_fixed64": []uint64{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_sfixed32": []int32{1, 2}},
		protobuild.Message{"repeated_sfixed32": []int32{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_sfixed64": []int32{1, 2}},
		protobuild.Message{"repeated_sfixed64": []int32{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_float": []float32{1, 2}},
		protobuild.Message{"repeated_float": []float32{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_double": []float64{1, 2}},
		protobuild.Message{"repeated_double": []float64{1, 3}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_bool": []bool{true, false}},
		protobuild.Message{"repeated_bool": []bool{true, true}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_string": []string{"a", "b"}},
		protobuild.Message{"repeated_string": []string{"a", "c"}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_bytes": [][]byte{[]byte("a"), []byte("b")}},
		protobuild.Message{"repeated_bytes": [][]byte{[]byte("a"), []byte("c")}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_nested_enum": []string{"FOO"}},
		protobuild.Message{"repeated_nested_enum": []string{"BAR"}},
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeatedgroup": []protobuild.Message{
			{"a": 1},
			{"a": 2},
		}},
		protobuild.Message{"repeatedgroup": []protobuild.Message{
			{"a": 1},
			{"a": 3},
		}},
		allTypesNoProto3...,
	))...)

	tests = append(tests, makeTest(test{desc: "Lists"}, makeXY(
		protobuild.Message{"repeated_nested_message": []protobuild.Message{
			{"a": 1},
			{"a": 2},
		}},
		protobuild.Message{"repeated_nested_message": []protobuild.Message{
			{"a": 1},
			{"a": 3},
		}},
	))...)

	// Maps: various configurations.

	allTypesNoExt := []proto.Message{
		&testpb.TestAllTypes{},
		&test3pb.TestAllTypes{},
		// TestAllExtensions is intentionally missing:
		// protoc prevents adding a map field to an extension:
		// Map fields are not allowed to be extensions.
		&testeditionspb.TestAllTypes{},
	}

	tests = append(tests, makeTest(test{desc: "MapsDifferent"}, makeXY(
		protobuild.Message{"map_int32_int32": map[int32]int32{1: 2}},
		protobuild.Message{"map_int32_int32": map[int32]int32{3: 4}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsAdditionalY"}, makeXY(
		protobuild.Message{"map_int32_int32": map[int32]int32{1: 2}},
		protobuild.Message{"map_int32_int32": map[int32]int32{1: 2, 3: 4}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsAdditionalX"}, makeXY(
		protobuild.Message{"map_int32_int32": map[int32]int32{1: 2, 3: 4}},
		protobuild.Message{"map_int32_int32": map[int32]int32{1: 2}},
		allTypesNoExt...,
	))...)

	// Maps: various types.
	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_int32_int32": map[int32]int32{1: 2, 3: 4}},
		protobuild.Message{"map_int32_int32": map[int32]int32{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_int64_int64": map[int64]int64{1: 2, 3: 4}},
		protobuild.Message{"map_int64_int64": map[int64]int64{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_uint32_uint32": map[uint32]uint32{1: 2, 3: 4}},
		protobuild.Message{"map_uint32_uint32": map[uint32]uint32{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_uint64_uint64": map[uint64]uint64{1: 2, 3: 4}},
		protobuild.Message{"map_uint64_uint64": map[uint64]uint64{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_sint32_sint32": map[int32]int32{1: 2, 3: 4}},
		protobuild.Message{"map_sint32_sint32": map[int32]int32{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_sint64_sint64": map[int64]int64{1: 2, 3: 4}},
		protobuild.Message{"map_sint64_sint64": map[int64]int64{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_fixed32_fixed32": map[uint32]uint32{1: 2, 3: 4}},
		protobuild.Message{"map_fixed32_fixed32": map[uint32]uint32{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_fixed64_fixed64": map[uint64]uint64{1: 2, 3: 4}},
		protobuild.Message{"map_fixed64_fixed64": map[uint64]uint64{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_sfixed32_sfixed32": map[int32]int32{1: 2, 3: 4}},
		protobuild.Message{"map_sfixed32_sfixed32": map[int32]int32{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_sfixed64_sfixed64": map[int64]int64{1: 2, 3: 4}},
		protobuild.Message{"map_sfixed64_sfixed64": map[int64]int64{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_int32_float": map[int32]float32{1: 2, 3: 4}},
		protobuild.Message{"map_int32_float": map[int32]float32{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_int32_double": map[int32]float64{1: 2, 3: 4}},
		protobuild.Message{"map_int32_double": map[int32]float64{1: 2, 3: 5}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_bool_bool": map[bool]bool{true: false, false: true}},
		protobuild.Message{"map_bool_bool": map[bool]bool{true: false, false: false}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_string_string": map[string]string{"a": "b", "c": "d"}},
		protobuild.Message{"map_string_string": map[string]string{"a": "b", "c": "e"}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_string_bytes": map[string][]byte{"a": []byte("b"), "c": []byte("d")}},
		protobuild.Message{"map_string_bytes": map[string][]byte{"a": []byte("b"), "c": []byte("e")}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_string_nested_message": map[string]protobuild.Message{
			"a": {"a": int32(1)},
			"b": {"a": int32(2)},
		}},
		protobuild.Message{"map_string_nested_message": map[string]protobuild.Message{
			"a": {"a": int32(1)},
			"b": {"a": int32(3)},
		}},
		allTypesNoExt...,
	))...)

	tests = append(tests, makeTest(test{desc: "MapsTypes"}, makeXY(
		protobuild.Message{"map_string_nested_enum": map[string]string{
			"a": "FOO",
			"b": "BAR",
		}},
		protobuild.Message{"map_string_nested_enum": map[string]string{
			"a": "FOO",
			"b": "BAZ",
		}},
		allTypesNoExt...,
	))...)

	// Unknown fields.

	tests = append(tests, makeTest(test{desc: "Unknown"}, makeXY(
		protobuild.Message{protobuild.Unknown: protopack.Message{
			protopack.Tag{100000, protopack.VarintType}, protopack.Varint(1),
		}.Marshal()},
		protobuild.Message{protobuild.Unknown: protopack.Message{
			protopack.Tag{100000, protopack.VarintType}, protopack.Varint(2),
		}.Marshal()},
	))...)

	tests = append(tests, makeTest(test{desc: "Unknown"}, makeXY(
		protobuild.Message{protobuild.Unknown: protopack.Message{
			protopack.Tag{100000, protopack.VarintType}, protopack.Varint(1),
		}.Marshal()},
		protobuild.Message{},
	))...)

	// Extensions.
	onlyExts := []proto.Message{
		&testpb.TestAllExtensions{},
		&testeditionspb.TestAllExtensions{},
	}

	tests = append(tests, makeTest(test{desc: "Extensions"}, makeXY(
		protobuild.Message{"optional_int32": 1},
		protobuild.Message{"optional_int32": 2},
		onlyExts...,
	))...)

	tests = append(tests, makeTest(test{desc: "Extensions"}, makeXY(
		protobuild.Message{},
		protobuild.Message{"optional_int32": 2},
		onlyExts...,
	))...)

	for _, tt := range tests {
		desc := tt.desc
		if desc == "" {
			desc = "Untitled"
		}
		desc += fmt.Sprintf("/x=%T y=%T", tt.x, tt.y)
		t.Run(desc, func(t *testing.T) {
			if !tt.eq && !proto.Equal(tt.x, tt.x) {
				t.Errorf("Equal(x, x) = false, want true\n==== x ====\n%v", prototext.Format(tt.x))
			}
			if !tt.eq && !proto.Equal(tt.y, tt.y) {
				t.Errorf("Equal(y, y) = false, want true\n==== y ====\n%v", prototext.Format(tt.y))
			}
			if eq := proto.Equal(tt.x, tt.y); eq != tt.eq {
				t.Errorf("Equal(x, y) = %v, want %v\n==== x ====\n%v==== y ====\n%v", eq, tt.eq, prototext.Format(tt.x), prototext.Format(tt.y))
			}
		})
	}
}

func BenchmarkEqualWithSmallEmpty(b *testing.B) {
	b.ReportAllocs()
	x := &testpb.ForeignMessage{}
	y := &testpb.ForeignMessage{}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		proto.Equal(x, y)
	}
}

func BenchmarkEqualWithIdenticalPtrEmpty(b *testing.B) {
	b.ReportAllocs()
	x := &testpb.ForeignMessage{}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		proto.Equal(x, x)
	}
}

func BenchmarkEqualWithLargeEmpty(b *testing.B) {
	b.ReportAllocs()
	x := &testpb.TestManyMessageFieldsMessage{
		F1:  makeNested(2),
		F10: makeNested(2),
		F20: makeNested(2),
		F30: makeNested(2),
		F40: makeNested(2),
		F50: makeNested(2),
		F60: makeNested(2),
		F70: makeNested(2),
		F80: makeNested(2),
		F90: makeNested(2),
	}
	y := &testpb.TestManyMessageFieldsMessage{
		F1:  makeNested(2),
		F10: makeNested(2),
		F20: makeNested(2),
		F30: makeNested(2),
		F40: makeNested(2),
		F50: makeNested(2),
		F60: makeNested(2),
		F70: makeNested(2),
		F80: makeNested(2),
		F90: makeNested(2),
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		proto.Equal(x, y)
	}
}

func makeNested(depth int) *testpb.TestAllTypes {
	if depth <= 0 {
		return nil
	}
	return &testpb.TestAllTypes{
		OptionalNestedMessage: &testpb.TestAllTypes_NestedMessage{
			Corecursive: makeNested(depth - 1),
		},
	}
}

func BenchmarkEqualWithDeeplyNestedEqual(b *testing.B) {
	b.ReportAllocs()
	x := makeNested(20)
	y := makeNested(20)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		proto.Equal(x, y)
	}
}

func BenchmarkEqualWithDeeplyNestedDifferent(b *testing.B) {
	b.ReportAllocs()
	x := makeNested(20)
	y := makeNested(21)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		proto.Equal(x, y)
	}
}

func BenchmarkEqualWithDeeplyNestedIdenticalPtr(b *testing.B) {
	b.ReportAllocs()
	x := makeNested(20)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		proto.Equal(x, x)
	}
}
