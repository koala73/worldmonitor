// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package proto_test

import (
	"testing"

	"google.golang.org/protobuf/proto"

	lazyopaquepb "google.golang.org/protobuf/internal/testprotos/lazy/lazy_opaque"
)

// testMessageLinked returns a test message with a few fields of various
// possible types filled in that nests more messages like a linked list.
func testMessageLinked(nesting int) *lazyopaquepb.Node {
	const (
		shortVarint = 23              // encodes into 1 byte
		longVarint  = 562949953421312 // encodes into 8 bytes
	)
	msg := lazyopaquepb.Node_builder{
		Int32:    proto.Int32(shortVarint),
		Int64:    proto.Int64(longVarint),
		Uint32:   proto.Uint32(shortVarint),
		Uint64:   proto.Uint64(longVarint),
		Sint32:   proto.Int32(shortVarint),
		Sint64:   proto.Int64(longVarint),
		Fixed32:  proto.Uint32(shortVarint),
		Fixed64:  proto.Uint64(longVarint),
		Sfixed32: proto.Int32(shortVarint),
		Sfixed64: proto.Int64(longVarint),
		Float:    proto.Float32(23.42),
		Double:   proto.Float64(23.42),
		Bool:     proto.Bool(true),
		String:   proto.String("hello"),
		Bytes:    []byte("world"),
	}.Build()
	if nesting > 0 {
		msg.SetNested(testMessageLinked(nesting - 1))
	}
	return msg
}

// A higher nesting level than 15 messages deep does not result in (relative)
// performance changes. In other words, the full effect of lazy decoding is
// visible with a nesting level of 15 messages deep. Lower nesting levels (like
// 5 messages deep) also show significant improvement.
const nesting = 15

func BenchmarkUnmarshal(b *testing.B) {
	encoded, err := proto.Marshal(testMessageLinked(nesting))
	if err != nil {
		b.Fatal(err)
	}

	for _, tt := range []struct {
		desc  string
		uopts proto.UnmarshalOptions
	}{
		{
			desc:  "lazy",
			uopts: proto.UnmarshalOptions{},
		},

		// When running the benchmark directly, print lazy vs. nolazy in the
		// same run. When using the benchstat tool, you can compare lazy
		// vs. nolazy by running only the lazy variant and disabling lazy
		// decoding with the -test_lazy_unmarshal command-line flag:
		//
		// benchstat \
		//   nolazy=<(go test -run=^$ -bench=Unmarshal/^lazy -count=6) \
		//   lazy=<(go test -run=^$ -bench=Unmarshal/^lazy -count=6 -test_lazy_unmarshal)
		{
			desc: "nolazy",
			uopts: proto.UnmarshalOptions{
				NoLazyDecoding: true,
			},
		},
	} {
		b.Run(tt.desc, func(b *testing.B) {
			b.ResetTimer()
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				out := &lazyopaquepb.Node{}
				if err := tt.uopts.Unmarshal(encoded, out); err != nil {
					b.Fatalf("can't unmarshal message: %v", err)
				}
			}
		})
	}
}
