// Copyright 2025 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package main

import (
	"reflect"
	"testing"

	"github.com/google/go-cmp/cmp"
	importoptionpb "google.golang.org/protobuf/cmd/protoc-gen-go/testdata/import_option"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/types/descriptorpb"

	// Ensure the custom option is linked into this test binary.
	// NB: import_option_unlinked is not linked into this test binary.
	importoptioncustompb "google.golang.org/protobuf/cmd/protoc-gen-go/testdata/import_option_custom"
)

func TestImportOption(t *testing.T) {
	var nilMessage *importoptionpb.TestMessage
	md := nilMessage.ProtoReflect().Descriptor()

	// Options from import option that are linked in should be available through
	// the extension API as usual.
	{
		fd := md.Fields().ByName("hello")
		fopts := fd.Options().(*descriptorpb.FieldOptions)
		if !proto.HasExtension(fopts, importoptioncustompb.E_FieldOption) {
			t.Errorf("FieldDescriptor(hello) does not have FieldOption extension set")
		}
	}

	// Options from import option that are not linked in should be in unknown bytes.
	{
		fd := md.Fields().ByName("world")
		fopts := fd.Options().(*descriptorpb.FieldOptions)
		unknown := fopts.ProtoReflect().GetUnknown()
		var fields []protowire.Number
		b := unknown
		for len(b) > 0 {
			num, _, n := protowire.ConsumeField(b)
			if n < 0 {
				t.Errorf("FieldDescriptor(world) contains invalid wire format: ConsumeField = %d", n)
			}
			fields = append(fields, num)
			b = b[n:]
		}
		want := []protowire.Number{504589222}
		if diff := cmp.Diff(want, fields); diff != "" {
			t.Errorf("FieldDescriptor(world) unknown bytes contain unexpected fields: diff (-want +got):\n%s", diff)
		}
	}

	// Verify that the option imports aren't lost when converting to descriptor protos.
	{
		fd := md.ParentFile()
		fdProto := protodesc.ToFileDescriptorProto(fd)
		expectedOptionImports := []string{
			"cmd/protoc-gen-go/testdata/import_option_custom/import_option_custom.proto",
			"cmd/protoc-gen-go/testdata/import_option_unlinked/import_option_unlinked.proto",
		}
		if !reflect.DeepEqual(expectedOptionImports, fdProto.GetOptionDependency()) {
			t.Errorf("option_dependency not correctly populated from protoreflect.FileDescriptor: want %v; got %v",
				expectedOptionImports, fdProto.GetOptionDependency())
		}
	}
}
