// Copyright 2018 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package prototext_test

import (
	"fmt"
	"strings"

	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	_ "google.golang.org/protobuf/internal/testprotos/textpbeditions"
	_ "google.golang.org/protobuf/internal/testprotos/textpbeditions/textpbeditions_opaque"
)

var relatedMessages = func() map[protoreflect.MessageType][]protoreflect.MessageType {
	related := map[protoreflect.MessageType][]protoreflect.MessageType{}
	const opaqueNamePrefix = "opaque."
	protoregistry.GlobalTypes.RangeMessages(func(mt protoreflect.MessageType) bool {
		name := mt.Descriptor().FullName()
		if !strings.HasPrefix(string(name), opaqueNamePrefix) {
			return true
		}
		mt1, err := protoregistry.GlobalTypes.FindMessageByName(name[len(opaqueNamePrefix):])
		if err != nil {
			panic(fmt.Sprintf("%v: can't find related message", name))
		}
		related[mt1] = append(related[mt1], mt)
		return true
	})
	return related
}()
