// Copyright 2025 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package protodesc

import (
	"testing"

	"google.golang.org/protobuf/internal/genid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
	"google.golang.org/protobuf/types/gofeaturespb"
)

func TestGoFeatures_NotExpectedType(t *testing.T) {
	md := (*gofeaturespb.GoFeatures)(nil).ProtoReflect().Descriptor()
	gf := dynamicpb.NewMessage(md)
	opaque := protoreflect.ValueOfEnum(gofeaturespb.GoFeatures_API_OPAQUE.Number())
	gf.Set(md.Fields().ByNumber(genid.GoFeatures_ApiLevel_field_number), opaque)
	dynamicExt := dynamicpb.NewExtensionType(gofeaturespb.E_Go.TypeDescriptor().Descriptor())

	extFile, err := NewFile(&descriptorpb.FileDescriptorProto{
		Name:       proto.String("test.proto"),
		Dependency: []string{"google/protobuf/descriptor.proto"},
		Extension: []*descriptorpb.FieldDescriptorProto{
			{
				Name:     proto.String("ext1002"),
				Number:   proto.Int32(int32(gofeaturespb.E_Go.TypeDescriptor().Number())),
				Type:     descriptorpb.FieldDescriptorProto_TYPE_STRING.Enum(),
				Label:    descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(),
				Extendee: proto.String(".google.protobuf.FeatureSet"),
			},
		},
	}, protoregistry.GlobalFiles)
	if err != nil {
		t.Fatal(err)
	}
	nonMessageExt := dynamicpb.NewExtensionType(extFile.Extensions().Get(0))

	extFdProto := ToFieldDescriptorProto(gofeaturespb.E_Go.TypeDescriptor().Descriptor())
	extMsgProto := ToDescriptorProto(gofeaturespb.E_Go.TypeDescriptor().Descriptor().Message())
	extMsgProto.Field = extMsgProto.Field[:1] // remove all but first field from the message
	extFile, err = NewFile(&descriptorpb.FileDescriptorProto{
		Name:        proto.String("google/protobuf/go_features.proto"),
		Package:     proto.String("pb"),
		Dependency:  []string{"google/protobuf/descriptor.proto"},
		Extension:   []*descriptorpb.FieldDescriptorProto{extFdProto},
		MessageType: []*descriptorpb.DescriptorProto{extMsgProto},
	}, protoregistry.GlobalFiles)
	if err != nil {
		t.Fatal(err)
	}
	missingFieldsExt := dynamicpb.NewExtensionType(extFile.Extensions().Get(0))
	gfMissingFields := dynamicpb.NewMessage(extFile.Messages().Get(0))
	gfPresentField := gfMissingFields.Descriptor().Fields().Get(0)
	gfMissingFields.Set(gfPresentField, gfMissingFields.NewField(gfPresentField))

	testCases := []struct {
		name string
		ext  protoreflect.ExtensionType
		val  any
	}{
		{
			name: "dynamic_message",
			ext:  dynamicExt,
			val:  gf,
		},
		{
			name: "not_a_message",
			ext:  nonMessageExt,
			val:  "abc",
		},
		{
			name: "message_missing_fields",
			ext:  missingFieldsExt,
			val:  gfMissingFields,
		},
	}
	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			featureSet := &descriptorpb.FeatureSet{}
			proto.SetExtension(featureSet, tc.ext, tc.val)

			fd := &descriptorpb.FileDescriptorProto{
				Name: proto.String("a.proto"),
				Dependency: []string{
					"google/protobuf/go_features.proto",
				},
				Edition: descriptorpb.Edition_EDITION_2023.Enum(),
				Syntax:  proto.String("editions"),
				Options: &descriptorpb.FileOptions{
					Features: featureSet,
				},
			}
			fds := &descriptorpb.FileDescriptorSet{
				File: []*descriptorpb.FileDescriptorProto{
					ToFileDescriptorProto(descriptorpb.File_google_protobuf_descriptor_proto),
					ToFileDescriptorProto(gofeaturespb.File_google_protobuf_go_features_proto),
					fd,
				},
			}
			if _, err := NewFiles(fds); err != nil {
				t.Fatal(err)
			}
		})
	}
}
