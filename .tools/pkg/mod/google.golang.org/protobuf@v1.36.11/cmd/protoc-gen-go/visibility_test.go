// Copyright 2025 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package main

import (
	"slices"
	"strings"
	"testing"

	visibilitypb "google.golang.org/protobuf/cmd/protoc-gen-go/testdata/visibility"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/types/descriptorpb"
)

func TestVisibility(t *testing.T) {
	// Verify that the visibility modifiers aren't lost when converting to descriptor protos.
	fd := visibilitypb.File_cmd_protoc_gen_go_testdata_visibility_visibility_proto
	fdProto := protodesc.ToFileDescriptorProto(fd)

	type testCase struct {
		name       string
		visibility descriptorpb.SymbolVisibility
	}
	testCases := []testCase{
		{
			name:       "DefaultMessage",
			visibility: descriptorpb.SymbolVisibility_VISIBILITY_UNSET,
		},
		{
			name:       "ExportMessage",
			visibility: descriptorpb.SymbolVisibility_VISIBILITY_EXPORT,
		},
		{
			name:       "LocalMessage",
			visibility: descriptorpb.SymbolVisibility_VISIBILITY_LOCAL,
		},
		{
			name:       "DefaultEnum",
			visibility: descriptorpb.SymbolVisibility_VISIBILITY_UNSET,
		},
		{
			name:       "ExportEnum",
			visibility: descriptorpb.SymbolVisibility_VISIBILITY_EXPORT,
		},
		{
			name:       "LocalEnum",
			visibility: descriptorpb.SymbolVisibility_VISIBILITY_LOCAL,
		},
	}
	// Instead of the boilerplate of handwritten cases for the nested types, we generate them
	// algorithmically:
	baseTestCases := slices.Clone(testCases)
	for _, topLevelCase := range baseTestCases {
		if strings.HasSuffix(topLevelCase.name, "Enum") {
			continue // only messages have nested types
		}
		for _, nestedCase := range baseTestCases {
			nestedCase.name = topLevelCase.name + ".Nested" + nestedCase.name
			testCases = append(testCases, nestedCase)
		}
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			path := strings.Split(tc.name, ".")
			decl, visPtr := findByName(fdProto.MessageType, fdProto.EnumType, path)

			if decl.GetVisibility() != tc.visibility {
				t.Errorf("expected %v to have %v visibility but instead got %v", decl.GetName(), tc.visibility, decl.GetVisibility())
			}
			if tc.visibility == descriptorpb.SymbolVisibility_VISIBILITY_UNSET {
				// For this one, we go one step further and expect the raw field to be a nil pointer.
				if visPtr != nil {
					t.Errorf("expected %v to have no visibility but instead got %v", decl.GetName(), visPtr)
				}
			}
		})
	}
}

func findByName(msgs []*descriptorpb.DescriptorProto, enums []*descriptorpb.EnumDescriptorProto, path []string) (hasVisibility, *descriptorpb.SymbolVisibility) {
	name := path[0]
	if len(path) > 1 {
		// Looking for nested type.
		for _, msg := range msgs {
			if msg.GetName() == name {
				return findByName(msg.NestedType, msg.EnumType, path[1:])
			}
		}
		return nil, nil
	}

	if strings.HasSuffix(name, "Enum") {
		for _, enum := range enums {
			if enum.GetName() == name {
				return enum, enum.Visibility
			}
		}
		return nil, nil
	}

	for _, msg := range msgs {
		if msg.GetName() == name {
			return msg, msg.Visibility
		}
	}
	return nil, nil
}

type hasVisibility interface {
	GetName() string
	GetVisibility() descriptorpb.SymbolVisibility
}
