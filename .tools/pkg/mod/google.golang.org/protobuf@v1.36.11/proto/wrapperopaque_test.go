// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package proto_test

import (
	"bytes"
	"testing"

	testhybridpb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_hybrid"
	"google.golang.org/protobuf/proto"
)

func TestOneofOrDefault(t *testing.T) {
	for _, tt := range []struct {
		desc  string
		input func() *testhybridpb.TestAllTypes
	}{
		{
			desc: "struct literal with nil nested message",
			input: func() *testhybridpb.TestAllTypes {
				return &testhybridpb.TestAllTypes{
					OneofField: &testhybridpb.TestAllTypes_OneofNestedMessage{
						OneofNestedMessage: nil,
					},
				}
			},
		},

		{
			desc: "struct literal with non-nil nested message",
			input: func() *testhybridpb.TestAllTypes {
				return &testhybridpb.TestAllTypes{
					OneofField: &testhybridpb.TestAllTypes_OneofNestedMessage{
						OneofNestedMessage: &testhybridpb.TestAllTypes_NestedMessage{},
					},
				}
			},
		},

		{
			desc: "opaque setter with ValueOrDefault",
			input: func() *testhybridpb.TestAllTypes {
				msg := &testhybridpb.TestAllTypes{}
				msg.ClearOneofString()
				var val *testhybridpb.TestAllTypes_NestedMessage
				msg.SetOneofNestedMessage(proto.ValueOrDefault(val))
				return msg
			},
		},

		{
			desc: "opaque builder with ValueOrDefault",
			input: func() *testhybridpb.TestAllTypes {
				var val *testhybridpb.TestAllTypes_NestedMessage
				return testhybridpb.TestAllTypes_builder{
					OneofNestedMessage: proto.ValueOrDefault(val),
				}.Build()
			},
		},
	} {
		t.Run(tt.desc, func(t *testing.T) {
			msg := tt.input()
			b, err := proto.Marshal(msg)
			if err != nil {
				t.Fatal(err)
			}
			want := []byte{130, 7, 0}
			if !bytes.Equal(b, want) {
				t.Fatalf("Marshal: got %x, want %x", b, want)
			}
			if !msg.HasOneofField() {
				t.Fatalf("HasOneofField was false, want true")
			}
			if got, want := msg.WhichOneofField(), testhybridpb.TestAllTypes_OneofNestedMessage_case; got != want {
				t.Fatalf("WhichOneofField: got %v, want %v", got, want)
			}
			if !msg.HasOneofNestedMessage() {
				t.Fatalf("HasOneofNestedMessage was false, want true")
			}
			if msg.HasOneofString() {
				t.Fatalf("HasOneofString was true, want false")
			}
		})
	}
}

func TestOneofOrDefaultBytes(t *testing.T) {
	for _, tt := range []struct {
		desc     string
		input    func() *testhybridpb.TestAllTypes
		wantWire []byte
	}{
		{
			desc: "struct literal with nil bytes",
			input: func() *testhybridpb.TestAllTypes {
				return &testhybridpb.TestAllTypes{
					OneofField: &testhybridpb.TestAllTypes_OneofBytes{
						OneofBytes: nil,
					},
				}
			},
		},

		{
			desc: "struct literal with non-nil bytes",
			input: func() *testhybridpb.TestAllTypes {
				return &testhybridpb.TestAllTypes{
					OneofField: &testhybridpb.TestAllTypes_OneofBytes{
						OneofBytes: []byte{},
					},
				}
			},
		},

		{
			desc: "opaque setter with ValueOrDefaultBytes",
			input: func() *testhybridpb.TestAllTypes {
				msg := &testhybridpb.TestAllTypes{}
				msg.ClearOneofString()
				var val []byte
				msg.SetOneofBytes(proto.ValueOrDefaultBytes(val))
				return msg
			},
		},

		{
			desc: "opaque setter",
			input: func() *testhybridpb.TestAllTypes {
				msg := &testhybridpb.TestAllTypes{}
				msg.ClearOneofString()
				var val []byte
				msg.SetOneofBytes(val)
				return msg
			},
		},

		{
			desc: "opaque builder with ValueOrDefaultBytes",
			input: func() *testhybridpb.TestAllTypes {
				var val []byte
				return testhybridpb.TestAllTypes_builder{
					OneofBytes: proto.ValueOrDefaultBytes(val),
				}.Build()
			},
		},
	} {
		t.Run(tt.desc, func(t *testing.T) {
			msg := tt.input()
			b, err := proto.Marshal(msg)
			if err != nil {
				t.Fatal(err)
			}
			want := []byte{146, 7, 0}
			if !bytes.Equal(b, want) {
				t.Fatalf("Marshal: got %x, want %x", b, want)
			}
			if !msg.HasOneofField() {
				t.Fatalf("HasOneofField was false, want true")
			}
			if got, want := msg.WhichOneofField(), testhybridpb.TestAllTypes_OneofBytes_case; got != want {
				t.Fatalf("WhichOneofField: got %v, want %v", got, want)
			}
			if !msg.HasOneofBytes() {
				t.Fatalf("HasOneofBytes was false, want true")
			}
			if msg.HasOneofString() {
				t.Fatalf("HasOneofString was true, want false")
			}
		})
	}
}
