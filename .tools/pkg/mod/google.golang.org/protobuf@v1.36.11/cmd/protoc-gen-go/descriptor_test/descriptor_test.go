// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package descriptor_test

import (
	"testing"

	testopenpb "google.golang.org/protobuf/internal/testprotos/test"
	testnopackagepb "google.golang.org/protobuf/internal/testprotos/test/test_nopackage"
	testoptionpb "google.golang.org/protobuf/internal/testprotos/test/test_option"
	testhybridpb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_hybrid"
	testopaquepb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_opaque"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/gofeaturespb"
)

func TestFileModeEnum(t *testing.T) {
	var e any = testopenpb.ForeignEnum_FOREIGN_FOO
	if _, ok := e.(interface{ EnumDescriptor() ([]byte, []int) }); !ok {
		t.Errorf("Open V1 proto did not have deprecated method EnumDescriptor")
	}
	var oe any = testopaquepb.ForeignEnum_FOREIGN_FOO
	if _, ok := oe.(interface{ EnumDescriptor() ([]byte, []int) }); ok {
		t.Errorf("Opaque V0 proto did have deprecated method EnumDescriptor")
	}
	var he any = testhybridpb.ForeignEnum_FOREIGN_FOO
	if _, ok := he.(interface{ EnumDescriptor() ([]byte, []int) }); ok {
		t.Errorf("Hybrid proto did have deprecated method EnumDescriptor")
	}
}

func TestFileModeMessage(t *testing.T) {
	var p any = &testopenpb.TestAllTypes{}
	if _, ok := p.(interface{ Descriptor() ([]byte, []int) }); !ok {
		t.Errorf("Open V1 proto did not have deprecated method Descriptor")
	}
	var op any = &testopaquepb.TestAllTypes{}
	if _, ok := op.(interface{ Descriptor() ([]byte, []int) }); ok {
		t.Errorf("Opaque V0 mode proto unexpectedly has deprecated Descriptor() method")
	}
	var hp any = &testhybridpb.TestAllTypes{}
	if _, ok := hp.(interface{ EnumDescriptor() ([]byte, []int) }); ok {
		t.Errorf("Hybrid proto did have deprecated method EnumDescriptor")
	}
}

func TestImportOption(t *testing.T) {
	m := &testoptionpb.OptionImportMessage{}
	mdesc := m.ProtoReflect().Descriptor()

	fileopts := mdesc.ParentFile().Options().(*descriptorpb.FileOptions)
	if proto.GetExtension(fileopts.Features, gofeaturespb.E_Go).(*gofeaturespb.GoFeatures).GetApiLevel() != gofeaturespb.GoFeatures_API_OPAQUE {
		t.Errorf("OptionImportMessage parent file options features does not have API_OPAQUE")
	}

	if proto.GetExtension(fileopts, testnopackagepb.E_NoPackageOption).(*testnopackagepb.NoPackageOption).GetName() != "no package option" {
		t.Errorf("OptionImportMessage parent file options does not have no_package_option")
	}
}
