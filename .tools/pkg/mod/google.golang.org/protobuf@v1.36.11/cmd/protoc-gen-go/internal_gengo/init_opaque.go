// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package internal_gengo

import "google.golang.org/protobuf/types/gofeaturespb"

func (m *messageInfo) isOpen() bool {
	return m.Message.APILevel == gofeaturespb.GoFeatures_API_OPEN
}

func (m *messageInfo) isHybrid() bool {
	return m.Message.APILevel == gofeaturespb.GoFeatures_API_HYBRID
}

func (m *messageInfo) isOpaque() bool {
	return m.Message.APILevel == gofeaturespb.GoFeatures_API_OPAQUE
}

func opaqueNewEnumInfoHook(f *fileInfo, e *enumInfo) {
	if f.File.APILevel != gofeaturespb.GoFeatures_API_OPEN {
		e.genJSONMethod = false
		e.genRawDescMethod = false
	}
}

func opaqueNewMessageInfoHook(f *fileInfo, m *messageInfo) {
	if !m.isOpen() {
		m.genRawDescMethod = false
		m.genExtRangeMethod = false
	}
}
