// Copyright 2019 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package proto_test

import (
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/internal/flags"
	"google.golang.org/protobuf/internal/protobuild"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/testing/protopack"

	"google.golang.org/protobuf/internal/testprotos/messageset/messagesetpb"
	_ "google.golang.org/protobuf/internal/testprotos/messageset/messagesetpb/messagesetpb_opaque"
	_ "google.golang.org/protobuf/internal/testprotos/messageset/msetextpb"
	_ "google.golang.org/protobuf/internal/testprotos/messageset/msetextpb/msetextpb_opaque"
)

func init() {
	if flags.ProtoLegacy {
		testValidMessages = append(testValidMessages, messageSetTestProtos...)
		testInvalidMessages = append(testInvalidMessages, messageSetInvalidTestProtos...)
	}
}

var messageSetTestProtos = []testProto{
	{
		desc: "MessageSet type_id before message content",
		decodeTo: makeMessages(
			protobuild.Message{
				"message_set": protobuild.Message{
					"message_set_ext1": protobuild.Message{
						"ext1_field1": 10,
					},
				},
			},
			&messagesetpb.MessageSetContainer{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.StartGroupType},
				protopack.Tag{2, protopack.VarintType}, protopack.Varint(1000),
				protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
					protopack.Tag{1, protopack.VarintType}, protopack.Varint(10),
				}),
				protopack.Tag{1, protopack.EndGroupType},
			}),
		}.Marshal(),
	},
	{
		desc: "MessageSet type_id after message content",
		decodeTo: makeMessages(
			protobuild.Message{
				"message_set": protobuild.Message{
					"message_set_ext1": protobuild.Message{
						"ext1_field1": 10,
					},
				},
			},
			&messagesetpb.MessageSetContainer{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.StartGroupType},
				protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
					protopack.Tag{1, protopack.VarintType}, protopack.Varint(10),
				}),
				protopack.Tag{2, protopack.VarintType}, protopack.Varint(1000),
				protopack.Tag{1, protopack.EndGroupType},
			}),
		}.Marshal(),
	},
	{
		desc: "MessageSet does not preserve unknown field",
		decodeTo: makeMessages(
			protobuild.Message{
				"message_set_ext1": protobuild.Message{
					"ext1_field1": 10,
				},
			},
			&messagesetpb.MessageSet{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.StartGroupType},
			protopack.Tag{2, protopack.VarintType}, protopack.Varint(1000),
			protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.VarintType}, protopack.Varint(10),
			}),
			protopack.Tag{1, protopack.EndGroupType},
			// Unknown field
			protopack.Tag{4, protopack.VarintType}, protopack.Varint(30),
		}.Marshal(),
	},
	{
		desc: "MessageSet with unknown type_id",
		decodeTo: makeMessages(
			protobuild.Message{
				protobuild.Unknown: protopack.Message{
					protopack.Tag{999, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
						protopack.Tag{1, protopack.VarintType}, protopack.Varint(10),
					}),
				}.Marshal(),
			},
			&messagesetpb.MessageSet{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.StartGroupType},
			protopack.Tag{2, protopack.VarintType}, protopack.Varint(999),
			protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.VarintType}, protopack.Varint(10),
			}),
			protopack.Tag{1, protopack.EndGroupType},
		}.Marshal(),
	},
	{
		desc: "MessageSet merges repeated message fields in item",
		decodeTo: makeMessages(
			protobuild.Message{
				"message_set_ext1": protobuild.Message{
					"ext1_field1": 10,
					"ext1_field2": 20,
				},
			},
			&messagesetpb.MessageSet{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.StartGroupType},
			protopack.Tag{2, protopack.VarintType}, protopack.Varint(1000),
			protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.VarintType}, protopack.Varint(10),
			}),
			protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{2, protopack.VarintType}, protopack.Varint(20),
			}),
			protopack.Tag{1, protopack.EndGroupType},
		}.Marshal(),
	},
	{
		desc: "MessageSet merges message fields in repeated items",
		decodeTo: makeMessages(
			protobuild.Message{
				"message_set_ext1": protobuild.Message{
					"ext1_field1": 10,
					"ext1_field2": 20,
				},
				"message_set_ext2": protobuild.Message{
					"ext2_field1": 30,
				},
			},
			&messagesetpb.MessageSet{},
		),
		wire: protopack.Message{
			// Ext1, field1
			protopack.Tag{1, protopack.StartGroupType},
			protopack.Tag{2, protopack.VarintType}, protopack.Varint(1000),
			protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.VarintType}, protopack.Varint(10),
			}),
			protopack.Tag{1, protopack.EndGroupType},
			// Ext2, field1
			protopack.Tag{1, protopack.StartGroupType},
			protopack.Tag{2, protopack.VarintType}, protopack.Varint(1001),
			protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.VarintType}, protopack.Varint(30),
			}),
			protopack.Tag{1, protopack.EndGroupType},
			// Ext2, field2
			protopack.Tag{1, protopack.StartGroupType},
			protopack.Tag{2, protopack.VarintType}, protopack.Varint(1000),
			protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{2, protopack.VarintType}, protopack.Varint(20),
			}),
			protopack.Tag{1, protopack.EndGroupType},
		}.Marshal(),
	},
	{
		desc: "MessageSet with missing type_id",
		decodeTo: makeMessages(
			protobuild.Message{},
			&messagesetpb.MessageSet{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.StartGroupType},
			protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.VarintType}, protopack.Varint(10),
			}),
			protopack.Tag{1, protopack.EndGroupType},
		}.Marshal(),
	},
	{
		desc: "MessageSet with missing message",
		decodeTo: makeMessages(
			protobuild.Message{
				"message_set_ext1": protobuild.Message{},
			},
			&messagesetpb.MessageSet{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.StartGroupType},
			protopack.Tag{2, protopack.VarintType}, protopack.Varint(1000),
			protopack.Tag{1, protopack.EndGroupType},
		}.Marshal(),
	},
	{
		desc: "MessageSet with type id out of valid field number range",
		decodeTo: makeMessages(
			protobuild.Message{
				"message_set": protobuild.Message{
					"message_set_extlarge": protobuild.Message{},
				},
			},
			&messagesetpb.MessageSetContainer{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.StartGroupType},
				protopack.Tag{2, protopack.VarintType}, protopack.Varint(protowire.MaxValidNumber + 1),
				protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{}),
				protopack.Tag{1, protopack.EndGroupType},
			}),
		}.Marshal(),
	},
	{
		desc: "MessageSet with unknown type id out of valid field number range",
		decodeTo: makeMessages(
			protobuild.Message{
				"message_set": protobuild.Message{
					protobuild.Unknown: protopack.Message{
						protopack.Tag{protowire.MaxValidNumber + 2, protopack.BytesType}, protopack.LengthPrefix{},
					}.Marshal(),
				},
			},
			&messagesetpb.MessageSetContainer{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.StartGroupType},
				protopack.Tag{2, protopack.VarintType}, protopack.Varint(protowire.MaxValidNumber + 2),
				protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{}),
				protopack.Tag{1, protopack.EndGroupType},
			}),
		}.Marshal(),
	},
	{
		desc: "MessageSet with unknown field",
		decodeTo: makeMessages(
			protobuild.Message{
				"message_set": protobuild.Message{
					"message_set_ext1": protobuild.Message{
						"ext1_field1": 10,
					},
				},
			},
			&messagesetpb.MessageSetContainer{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.StartGroupType},
				protopack.Tag{2, protopack.VarintType}, protopack.Varint(1000),
				protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
					protopack.Tag{1, protopack.VarintType}, protopack.Varint(10),
				}),
				protopack.Tag{4, protopack.VarintType}, protopack.Varint(0),
				protopack.Tag{1, protopack.EndGroupType},
			}),
		}.Marshal(),
	},
	{
		desc:          "MessageSet with required field set",
		checkFastInit: true,
		decodeTo: makeMessages(
			protobuild.Message{
				"message_set": protobuild.Message{
					"message_set_extrequired": protobuild.Message{
						"required_field1": 1,
					},
				},
			},
			&messagesetpb.MessageSetContainer{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.StartGroupType},
				protopack.Tag{2, protopack.VarintType}, protopack.Varint(1002),
				protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
					protopack.Tag{1, protopack.VarintType}, protopack.Varint(1),
				}),
				protopack.Tag{1, protopack.EndGroupType},
			}),
		}.Marshal(),
	},
	{
		desc:          "MessageSet with required field unset",
		checkFastInit: true,
		partial:       true,
		decodeTo: makeMessages(
			protobuild.Message{
				"message_set": protobuild.Message{
					"message_set_extrequired": protobuild.Message{},
				},
			},
			&messagesetpb.MessageSetContainer{},
		),
		wire: protopack.Message{
			protopack.Tag{1, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.StartGroupType},
				protopack.Tag{2, protopack.VarintType}, protopack.Varint(1002),
				protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{}),
				protopack.Tag{1, protopack.EndGroupType},
			}),
		}.Marshal(),
	},
}

var messageSetInvalidTestProtos = []testProto{
	{
		desc: "MessageSet with type id 0",
		decodeTo: []proto.Message{
			(*messagesetpb.MessageSetContainer)(nil),
		},
		wire: protopack.Message{
			protopack.Tag{1, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.StartGroupType},
				protopack.Tag{2, protopack.VarintType}, protopack.Uvarint(0),
				protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{}),
				protopack.Tag{1, protopack.EndGroupType},
			}),
		}.Marshal(),
	},
	{
		desc: "MessageSet with type id overflowing int32",
		decodeTo: []proto.Message{
			(*messagesetpb.MessageSetContainer)(nil),
		},
		wire: protopack.Message{
			protopack.Tag{1, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{
				protopack.Tag{1, protopack.StartGroupType},
				protopack.Tag{2, protopack.VarintType}, protopack.Uvarint(0x80000000),
				protopack.Tag{3, protopack.BytesType}, protopack.LengthPrefix(protopack.Message{}),
				protopack.Tag{1, protopack.EndGroupType},
			}),
		}.Marshal(),
	},
}
