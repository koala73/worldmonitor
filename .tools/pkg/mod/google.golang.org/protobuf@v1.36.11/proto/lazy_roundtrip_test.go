// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package proto_test

import (
	"reflect"
	"testing"
	"unsafe"

	"github.com/google/go-cmp/cmp"
	"google.golang.org/protobuf/internal/impl"
	testopaquepb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_opaque"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/testing/protocmp"
)

func fillLazyRequiredMessage() *testopaquepb.TestRequiredLazy {
	return testopaquepb.TestRequiredLazy_builder{
		OptionalLazyMessage: testopaquepb.TestRequired_builder{
			RequiredField: proto.Int32(12),
		}.Build(),
	}.Build()
}

func expandedLazy(m *testopaquepb.TestRequiredLazy) bool {
	v := reflect.ValueOf(m).Elem()
	rf := v.FieldByName("xxx_hidden_OptionalLazyMessage")
	rf = reflect.NewAt(rf.Type(), unsafe.Pointer(rf.UnsafeAddr())).Elem()
	return rf.Pointer() != 0
}

// This test ensures that a lazy field keeps being lazy when marshalling
// even if it has required fields (as they have already been checked on
// unmarshal)
func TestLazyRequiredRoundtrip(t *testing.T) {
	if !impl.LazyEnabled() {
		t.Skipf("this test requires lazy decoding to be enabled")
	}
	m := fillLazyRequiredMessage()
	b, _ := proto.MarshalOptions{}.Marshal(m)
	ml := &testopaquepb.TestRequiredLazy{}
	err := proto.UnmarshalOptions{}.Unmarshal(b, ml)
	if err != nil {
		t.Fatalf("Error while unmarshaling: %v", err)
	}
	// Sanity check, we should have all unexpanded fields in the proto
	if expandedLazy(ml) {
		t.Fatalf("Proto is not lazy: %#v", ml)
	}
	// Now we marshal the lazy field. It should still be unexpanded
	_, _ = proto.MarshalOptions{}.Marshal(ml)

	if expandedLazy(ml) {
		t.Errorf("Proto got expanded by marshal: %#v", ml)
	}

	// The following tests the current behavior for cases where we
	// cannot guarantee the integrity of the lazy unmarshalled buffer
	// because of required fields. This would have to be updated if
	// we find another way to check required fields than simply
	// unmarshalling everything that has them when we're not sure.

	ml = &testopaquepb.TestRequiredLazy{}
	err = proto.UnmarshalOptions{AllowPartial: true}.Unmarshal(b, ml)
	if err != nil {
		t.Fatalf("Error while unmarshaling: %v", err)
	}
	// Sanity check, we should have all unexpanded fields in the proto.
	if expandedLazy(ml) {
		t.Fatalf("Proto is not lazy: %#v", ml)
	}
	// Now we marshal the proto. The lazy fields will be expanded to
	// check required fields.
	_, _ = proto.MarshalOptions{}.Marshal(ml)

	if !expandedLazy(ml) {
		t.Errorf("Proto did not get expanded by marshal: %#v", ml)
	}

	// Finally, we test to see that the fields to not get expanded
	// if we are consistently using AllowPartial both for marshal
	// and unmarshal.
	ml = &testopaquepb.TestRequiredLazy{}
	err = proto.UnmarshalOptions{AllowPartial: true}.Unmarshal(b, ml)
	if err != nil {
		t.Fatalf("Error while unmarshaling: %v", err)
	}
	// Sanity check, we should have all unexpanded fields in the proto.
	if expandedLazy(ml) {
		t.Fatalf("Proto is not lazy: %#v", ml)
	}
	// Now we marshal the proto. The lazy fields will be expanded to
	// check required fields.
	_, _ = proto.MarshalOptions{AllowPartial: true}.Marshal(ml)

	if expandedLazy(ml) {
		t.Errorf("Proto did not get expanded by marshal: %#v", ml)
	}

}

func TestRoundtripMap(t *testing.T) {
	m := testopaquepb.TestAllTypes_builder{
		OptionalLazyNestedMessage: testopaquepb.TestAllTypes_NestedMessage_builder{
			Corecursive: testopaquepb.TestAllTypes_builder{
				MapStringString: map[string]string{
					"a": "b",
				},
			}.Build(),
		}.Build(),
	}.Build()
	b, err := proto.Marshal(m)
	if err != nil {
		t.Fatalf("proto.Marshal: %v", err)
	}
	got := &testopaquepb.TestAllTypes{}
	if err := proto.Unmarshal(b, got); err != nil {
		t.Fatalf("proto.Unmarshal: %v", err)
	}
	if diff := cmp.Diff(m, got, protocmp.Transform()); diff != "" {
		t.Errorf("not the same: diff (-want +got):\n%s", diff)
	}
}
