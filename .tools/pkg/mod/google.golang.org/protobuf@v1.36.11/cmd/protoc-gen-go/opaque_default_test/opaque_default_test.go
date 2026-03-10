// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package opaque_default_test

import (
	"testing"

	enumopaquepb "google.golang.org/protobuf/internal/testprotos/enums/enums_opaque"
	testopaquepb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_opaque"
)

// From the spec: "Proto2 enums use the first syntactic entry in the enum
// declaration as the default value where it is otherwise unspecified."
func TestOpaqueEnumDefaults(t *testing.T) {
	m := &testopaquepb.RemoteDefault{}
	if got, want := m.GetDefault(), enumopaquepb.Enum_DEFAULT; got != want {
		t.Errorf("default enum value: got %v, expected %v", got, want)
	}
}
