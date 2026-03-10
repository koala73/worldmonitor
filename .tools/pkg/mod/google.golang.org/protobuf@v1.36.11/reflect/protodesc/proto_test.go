// Copyright 2018 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package protodesc

import (
	"testing"

	"github.com/google/go-cmp/cmp"
	"google.golang.org/protobuf/internal/filedesc"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/testing/protocmp"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

func TestEditionsRequired(t *testing.T) {
	fd := new(filedesc.Field)
	fd.L0.ParentFile = filedesc.SurrogateEdition2023
	fd.L0.FullName = "foo_field"
	fd.L1.Number = 1337
	fd.L1.Cardinality = protoreflect.Required
	fd.L1.Kind = protoreflect.BytesKind

	want := &descriptorpb.FieldDescriptorProto{
		Name:   proto.String("foo_field"),
		Number: proto.Int32(1337),
		Label:  descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(),
		Type:   descriptorpb.FieldDescriptorProto_TYPE_BYTES.Enum(),
	}

	got := ToFieldDescriptorProto(fd)
	if diff := cmp.Diff(want, got, protocmp.Transform()); diff != "" {
		t.Errorf("ToFieldDescriptor: unexpected diff (-want +got):\n%s", diff)
	}
}

func TestProto2Required(t *testing.T) {
	fd := new(filedesc.Field)
	fd.L0.ParentFile = filedesc.SurrogateProto2
	fd.L0.FullName = "foo_field"
	fd.L1.Number = 1337
	fd.L1.Cardinality = protoreflect.Required
	fd.L1.Kind = protoreflect.BytesKind

	want := &descriptorpb.FieldDescriptorProto{
		Name:   proto.String("foo_field"),
		Number: proto.Int32(1337),
		Label:  descriptorpb.FieldDescriptorProto_LABEL_REQUIRED.Enum(),
		Type:   descriptorpb.FieldDescriptorProto_TYPE_BYTES.Enum(),
	}

	got := ToFieldDescriptorProto(fd)
	if diff := cmp.Diff(want, got, protocmp.Transform()); diff != "" {
		t.Errorf("ToFieldDescriptor: unexpected diff (-want +got):\n%s", diff)
	}
}

func TestEditionsDelimited(t *testing.T) {
	md := new(filedesc.Message)
	md.L0.ParentFile = filedesc.SurrogateEdition2023
	md.L0.FullName = "foo_message"
	fd := new(filedesc.Field)
	fd.L0.ParentFile = filedesc.SurrogateEdition2023
	fd.L0.FullName = "foo_field"
	fd.L1.Number = 1337
	fd.L1.Cardinality = protoreflect.Optional
	fd.L1.Kind = protoreflect.GroupKind
	fd.L1.Message = md

	want := &descriptorpb.FieldDescriptorProto{
		Name:     proto.String("foo_field"),
		Number:   proto.Int32(1337),
		Label:    descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(),
		Type:     descriptorpb.FieldDescriptorProto_TYPE_MESSAGE.Enum(),
		TypeName: proto.String(".foo_message"),
	}

	got := ToFieldDescriptorProto(fd)
	if diff := cmp.Diff(want, got, protocmp.Transform()); diff != "" {
		t.Errorf("ToFieldDescriptor: unexpected diff (-want +got):\n%s", diff)
	}
}

func TestProto2Group(t *testing.T) {
	md := new(filedesc.Message)
	md.L0.ParentFile = filedesc.SurrogateProto2
	md.L0.FullName = "foo_message"
	fd := new(filedesc.Field)
	fd.L0.ParentFile = filedesc.SurrogateProto2
	fd.L0.FullName = "foo_field"
	fd.L1.Number = 1337
	fd.L1.Cardinality = protoreflect.Optional
	fd.L1.Kind = protoreflect.GroupKind
	fd.L1.Message = md

	want := &descriptorpb.FieldDescriptorProto{
		Name:     proto.String("foo_field"),
		Number:   proto.Int32(1337),
		Label:    descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(),
		Type:     descriptorpb.FieldDescriptorProto_TYPE_GROUP.Enum(),
		TypeName: proto.String(".foo_message"),
	}

	got := ToFieldDescriptorProto(fd)
	if diff := cmp.Diff(want, got, protocmp.Transform()); diff != "" {
		t.Errorf("ToFieldDescriptor: unexpected diff (-want +got):\n%s", diff)
	}
}

func TestEdition2024Attributes(t *testing.T) {
	// Edition 2024 introduces new language capabilities which are used to populate new
	// attributes in a FileDescriptorProto. But none of them are used by the runtime so
	// are not accessible via protoreflect.FileDescriptor. This verifies that, despite
	// there not being a way to access them through a protoreflect.FileDescriptor, they
	// still successfully make it through a round-trip of descriptor proto -> descriptor
	// and back.
	optionsProto := &descriptorpb.FileDescriptorProto{
		Name:       proto.String("foo_options.proto"),
		Package:    proto.String("foo"),
		Syntax:     proto.String("proto3"),
		Dependency: []string{"google/protobuf/descriptor.proto"},
		Extension: []*descriptorpb.FieldDescriptorProto{
			{
				Extendee: proto.String("google.protobuf.FileOptions"),
				Name:     proto.String("foo_option"),
				Type:     descriptorpb.FieldDescriptorProto_TYPE_STRING.Enum(),
				Label:    descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(),
				Number:   proto.Int32(10101),
			},
		},
	}

	fd, err := NewFile(optionsProto, protoregistry.GlobalFiles)
	if err != nil {
		t.Fatalf("failed to create protoreflect.FileDescriptor: %v", err)
	}
	fooFileOption := dynamicpb.NewExtensionType(fd.Extensions().Get(0))
	fileOpts := &descriptorpb.FileOptions{}
	proto.SetExtension(fileOpts, fooFileOption, "abc")

	msgs := []*descriptorpb.DescriptorProto{
		{
			Name: proto.String("DefaultMessage"),
		},
		{
			Name:       proto.String("ExportMessage"),
			Visibility: descriptorpb.SymbolVisibility_VISIBILITY_EXPORT.Enum(),
		},
		{
			Name:       proto.String("LocalMessage"),
			Visibility: descriptorpb.SymbolVisibility_VISIBILITY_LOCAL.Enum(),
		},
	}
	enums := []*descriptorpb.EnumDescriptorProto{
		{
			Name: proto.String("DefaultEnum"),
			Value: []*descriptorpb.EnumValueDescriptorProto{
				{
					Name:   proto.String("DEFAULT_ZERO"),
					Number: proto.Int32(0),
				},
			},
		},
		{
			Name:       proto.String("ExportEnum"),
			Visibility: descriptorpb.SymbolVisibility_VISIBILITY_EXPORT.Enum(),
			Value: []*descriptorpb.EnumValueDescriptorProto{
				{
					Name:   proto.String("EXPORT_ZERO"),
					Number: proto.Int32(0),
				},
			},
		},
		{
			Name:       proto.String("LocalEnum"),
			Visibility: descriptorpb.SymbolVisibility_VISIBILITY_LOCAL.Enum(),
			Value: []*descriptorpb.EnumValueDescriptorProto{
				{
					Name:   proto.String("LOCAL_ZERO"),
					Number: proto.Int32(0),
				},
			},
		},
	}

	fdProto := &descriptorpb.FileDescriptorProto{
		Name:             proto.String("foo.proto"),
		Package:          proto.String("foo"),
		Syntax:           proto.String("editions"),
		Edition:          descriptorpb.Edition_EDITION_2024.Enum(),
		OptionDependency: []string{"foo_options.proto"},
		Options:          fileOpts,
		MessageType: []*descriptorpb.DescriptorProto{
			{
				Name:       proto.String("DefaultMessage"),
				NestedType: msgs,
				EnumType:   enums,
			},
			{
				Name:       proto.String("ExportMessage"),
				Visibility: descriptorpb.SymbolVisibility_VISIBILITY_EXPORT.Enum(),
				NestedType: msgs,
				EnumType:   enums,
			},
			{
				Name:       proto.String("LocalMessage"),
				Visibility: descriptorpb.SymbolVisibility_VISIBILITY_LOCAL.Enum(),
				NestedType: msgs,
				EnumType:   enums,
			},
		},
		EnumType: enums,
	}

	var reg protoregistry.Files
	if err := reg.RegisterFile(descriptorpb.File_google_protobuf_descriptor_proto); err != nil {
		t.Fatalf("failed to register google/protobuf/descriptor.proto: %v", err)
	}
	if err := reg.RegisterFile(fd); err != nil {
		t.Fatalf("failed to register foo_options.proto: %v", err)
	}
	fd, err = NewFile(fdProto, &reg)
	if err != nil {
		t.Fatalf("failed to create protoreflect.FileDescriptor: %v", err)
	}

	roundTripped := ToFileDescriptorProto(fd)
	if diff := cmp.Diff(fdProto, roundTripped, protocmp.Transform()); diff != "" {
		t.Fatalf("file did not survive round trip unchanged; diff:\n%s", diff)
	}
}
