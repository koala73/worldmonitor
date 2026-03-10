// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package protogen

import (
	"fmt"

	"google.golang.org/protobuf/internal/filedesc"
	"google.golang.org/protobuf/internal/genid"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/gofeaturespb"
)

func fileAPILevel(fd protoreflect.FileDescriptor, def gofeaturespb.GoFeatures_APILevel) gofeaturespb.GoFeatures_APILevel {
	level := gofeaturespb.GoFeatures_API_OPEN
	level = def
	if fd, ok := fd.(*filedesc.File); ok {
		al := fd.L1.EditionFeatures.APILevel
		if al != genid.GoFeatures_API_LEVEL_UNSPECIFIED_enum_value {
			level = gofeaturespb.GoFeatures_APILevel(al)
		}
	}

	return level
}

func messageAPILevel(md protoreflect.MessageDescriptor, def gofeaturespb.GoFeatures_APILevel) gofeaturespb.GoFeatures_APILevel {
	level := def
	if md, ok := md.(*filedesc.Message); ok {
		al := md.L1.EditionFeatures.APILevel
		if al != genid.GoFeatures_API_LEVEL_UNSPECIFIED_enum_value {
			level = gofeaturespb.GoFeatures_APILevel(al)
		}
	}

	return level
}

func (p *Plugin) defaultAPILevel() gofeaturespb.GoFeatures_APILevel {
	if p.opts.DefaultAPILevel != gofeaturespb.GoFeatures_API_LEVEL_UNSPECIFIED {
		return p.opts.DefaultAPILevel
	}

	return gofeaturespb.GoFeatures_API_OPEN
}

// MethodName returns the (possibly mangled) name of the generated accessor
// method, along with the backwards-compatible name (if needed).
//
// method must be one of Get, Set, Has, Clear. MethodName panics otherwise.
func (field *Field) MethodName(method string) (name, compat string) {
	switch method {
	case "Get":
		return field.getterName()

	case "Set":
		return field.setterName()

	case "Has", "Clear":
		return field.methodName(method), ""

	default:
		panic(fmt.Sprintf("Field.MethodName called for unknown method %q", method))
	}
}

// methodName returns the (possibly mangled) name of the generated method with
// the given prefix.
//
// For the Open API, the return value is "".
func (field *Field) methodName(prefix string) string {
	switch field.Parent.APILevel {
	case gofeaturespb.GoFeatures_API_OPEN:
		// In the Open API, only generate getters (no Has or Clear methods).
		return ""

	case gofeaturespb.GoFeatures_API_HYBRID:
		var infix string
		if field.hasConflictHybrid {
			infix = "_"
		}
		return prefix + infix + field.camelCase

	case gofeaturespb.GoFeatures_API_OPAQUE:
		return prefix + field.camelCase

	default:
		panic("BUG: message is neither open, nor hybrid, nor opaque?!")
	}
}

// getterName returns the (possibly mangled) name of the generated Get method,
// along with the backwards-compatible name (if needed).
func (field *Field) getterName() (getter, compat string) {
	switch field.Parent.APILevel {
	case gofeaturespb.GoFeatures_API_OPEN:
		// In the Open API, only generate a getter with the old style mangled name.
		return "Get" + field.GoName, ""

	case gofeaturespb.GoFeatures_API_HYBRID:
		// In the Hybrid API, return the mangled getter name and the old style
		// name if needed, for backwards compatibility with the Open API.
		var infix string
		if field.hasConflictHybrid {
			infix = "_"
		}
		orig := "Get" + infix + field.camelCase
		mangled := "Get" + field.GoName
		if mangled == orig {
			mangled = ""
		}
		return orig, mangled

	case gofeaturespb.GoFeatures_API_OPAQUE:
		return field.methodName("Get"), ""

	default:
		panic("BUG: message is neither open, nor hybrid, nor opaque?!")
	}
}

// setterName returns the (possibly mangled) name of the generated Set method,
// along with the backwards-compatible name (if needed).
func (field *Field) setterName() (setter, compat string) {
	return field.methodName("Set"), ""
}

// BuilderFieldName returns the name of this field in the corresponding _builder
// struct.
func (field *Field) BuilderFieldName() string {
	return field.camelCase
}

// MethodName returns the (possibly mangled) name of the generated accessor
// method.
//
// method must be one of Has, Clear, Which. MethodName panics otherwise.
func (oneof *Oneof) MethodName(method string) string {
	switch method {
	case "Has", "Clear", "Which":
		return oneof.methodName(method)

	default:
		panic(fmt.Sprintf("Oneof.MethodName called for unknown method %q", method))
	}
}

// methodName returns the (possibly mangled) name of the generated method with
// the given prefix.
//
// For the Open API, the return value is "".
func (oneof *Oneof) methodName(prefix string) string {
	switch oneof.Parent.APILevel {
	case gofeaturespb.GoFeatures_API_OPEN:
		// In the Open API, only generate getters.
		return ""

	case gofeaturespb.GoFeatures_API_HYBRID:
		var infix string
		if oneof.hasConflictHybrid {
			infix = "_"
		}
		return prefix + infix + oneof.camelCase

	case gofeaturespb.GoFeatures_API_OPAQUE:
		return prefix + oneof.camelCase

	default:
		panic("BUG: message is neither open, nor hybrid, nor opaque?!")
	}
}
