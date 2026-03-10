// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package opaque_map_test

import (
	"testing"

	testopaquepb "google.golang.org/protobuf/internal/testprotos/testeditions/testeditions_opaque"
)

func TestOpaqueMap(t *testing.T) {
	m := &testopaquepb.TestAllTypes{}

	m.SetMapStringString(map[string]string{"one": "eins"})
	if got, want := len(m.GetMapStringString()), 1; got != want {
		t.Errorf("after setting map_string_string to a non-empty map: len(m.GetMapStringString()) = %v, want %v", got, want)
	}
	delete(m.GetMapStringString(), "one")
	if got, want := len(m.GetMapStringString()), 0; got != want {
		t.Errorf("after removing all elements from m_one: len(m.GetMapStringString()) = %v, want %v", got, want)
	}
	if got := m.GetMapStringString(); got == nil {
		t.Errorf("after removing all elements from m_one: m.GetMapStringString() = nil, want non-nil map")
	}
	m.GetMapStringString()["two"] = "zwei"
	if got, want := len(m.GetMapStringString()), 1; got != want {
		t.Errorf("after adding new element to m_one: len(m.GetMapStringString()) = %v, want %v", got, want)
	}
	m.SetMapStringString(map[string]string{})
	if got := m.GetMapStringString(); got == nil {
		t.Errorf("after setting m_one to an empty map: m.GetMapStringString() = nil, want non-nil map")
	}
}
