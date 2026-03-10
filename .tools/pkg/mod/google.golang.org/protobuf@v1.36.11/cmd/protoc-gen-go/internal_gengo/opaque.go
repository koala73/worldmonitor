// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package internal_gengo

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"google.golang.org/protobuf/compiler/protogen"
	"google.golang.org/protobuf/internal/filedesc"
	"google.golang.org/protobuf/internal/genid"
	"google.golang.org/protobuf/reflect/protoreflect"

	"google.golang.org/protobuf/types/descriptorpb"
)

func opaqueGenMessageHook(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo) bool {
	opaqueGenMessage(g, f, message)
	return true
}

func opaqueGenMessage(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo) {
	// Message type declaration.
	g.AnnotateSymbol(message.GoIdent.GoName, protogen.Annotation{Location: message.Location})
	leadingComments := appendDeprecationSuffix(message.Comments.Leading,
		message.Desc.ParentFile(),
		message.Desc.Options().(*descriptorpb.MessageOptions).GetDeprecated())
	g.P(leadingComments,
		"type ", message.GoIdent, " struct {")

	sf := f.allMessageFieldsByPtr[message]
	if sf == nil {
		sf = new(structFields)
		f.allMessageFieldsByPtr[message] = sf
	}

	var tags structTags
	switch {
	case message.isOpen():
		tags = structTags{{"protogen", "open.v1"}}
	case message.isHybrid():
		tags = structTags{{"protogen", "hybrid.v1"}}
	case message.isOpaque():
		tags = structTags{{"protogen", "opaque.v1"}}
	}

	g.P(genid.State_goname, " ", protoimplPackage.Ident("MessageState"), tags)
	sf.append(genid.State_goname)
	fields := message.Fields
	for _, field := range fields {
		opaqueGenMessageField(g, f, message, field, sf)
	}
	opaqueGenMessageInternalFields(g, f, message, sf)
	g.P("}")
	g.P()

	genMessageKnownFunctions(g, f, message)
	genMessageDefaultDecls(g, f, message)
	opaqueGenMessageMethods(g, f, message)
	opaqueGenMessageBuilder(g, f, message)
	opaqueGenOneofWrapperTypes(g, f, message)
}

// opaqueGenMessageField generates a struct field.
func opaqueGenMessageField(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, field *protogen.Field, sf *structFields) {
	if oneof := field.Oneof; oneof != nil && !oneof.Desc.IsSynthetic() {
		// It would be a bit simpler to iterate over the oneofs below,
		// but generating the field here keeps the contents of the Go
		// struct in the same order as the contents of the source
		// .proto file.
		if field != oneof.Fields[0] {
			return
		}
		opaqueGenOneofFields(g, f, message, oneof, sf)
		return
	}

	goType, pointer := opaqueFieldGoType(g, f, message, field)
	if pointer {
		goType = "*" + goType
	}
	protobufTagValue := fieldProtobufTagValue(field)
	jsonTagValue := fieldJSONTagValue(field)
	if g.InternalStripForEditionsDiff() {
		if field.Desc.ContainingOneof() != nil && field.Desc.ContainingOneof().IsSynthetic() {
			protobufTagValue = strings.ReplaceAll(protobufTagValue, ",oneof", "")
		}
		protobufTagValue = strings.ReplaceAll(protobufTagValue, ",proto3", "")
	}
	tags := structTags{
		{"protobuf", protobufTagValue},
	}
	if !message.isOpaque() {
		tags = append(tags, structTags{{"json", jsonTagValue}}...)
	}
	if field.Desc.IsMap() {
		keyTagValue := fieldProtobufTagValue(field.Message.Fields[0])
		valTagValue := fieldProtobufTagValue(field.Message.Fields[1])
		keyTagValue = strings.ReplaceAll(keyTagValue, ",proto3", "")
		valTagValue = strings.ReplaceAll(valTagValue, ",proto3", "")
		tags = append(tags, structTags{
			{"protobuf_key", keyTagValue},
			{"protobuf_val", valTagValue},
		}...)
	}

	name := field.GoName
	if message.isOpaque() {
		name = "xxx_hidden_" + name
	}

	if message.isOpaque() {
		g.P(name, " ", goType, tags)
		sf.append(name)
		if message.isTracked {
			g.P("// Deprecated: Do not use. This will be deleted in the near future.")
			g.P("XXX_ft_", field.GoName, " struct{} `go:\"track\"`")
			sf.append("XXX_ft_" + field.GoName)
		}
	} else {
		if message.isTracked {
			tags = append(tags, structTags{
				{"go", "track"},
			}...)
		}
		g.AnnotateSymbol(field.Parent.GoIdent.GoName+"."+name, protogen.Annotation{Location: field.Location})
		leadingComments := appendDeprecationSuffix(field.Comments.Leading,
			field.Desc.ParentFile(),
			field.Desc.Options().(*descriptorpb.FieldOptions).GetDeprecated())
		g.P(leadingComments,
			name, " ", goType, tags,
			trailingComment(field.Comments.Trailing))
		sf.append(name)
	}
}

// opaqueGenOneofFields generates the message fields for a oneof.
func opaqueGenOneofFields(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, oneof *protogen.Oneof, sf *structFields) {
	tags := structTags{
		{"protobuf_oneof", string(oneof.Desc.Name())},
	}
	if message.isTracked {
		tags = append(tags, structTags{
			{"go", "track"},
		}...)
	}

	oneofName := opaqueOneofFieldName(oneof, message.isOpaque())
	goType := opaqueOneofInterfaceName(oneof)

	if message.isOpaque() {
		g.P(oneofName, " ", goType, tags)
		sf.append(oneofName)
		if message.isTracked {
			g.P("// Deprecated: Do not use. This will be deleted in the near future.")
			g.P("XXX_ft_", oneof.GoName, " struct{} `go:\"track\"`")
			sf.append("XXX_ft_" + oneof.GoName)
		}
		return
	}

	leadingComments := oneof.Comments.Leading
	if leadingComments != "" {
		leadingComments += "\n"
	}
	// NOTE(rsc): The extra \n here is working around #52605,
	// making the comment be in Go 1.19 doc comment format
	// even though it's not really a doc comment.
	ss := []string{" Types that are valid to be assigned to ", oneofName, ":\n\n"}
	for _, field := range oneof.Fields {
		ss = append(ss, "\t*"+opaqueFieldOneofType(field, message.isOpaque()).GoName+"\n")
	}
	leadingComments += protogen.Comments(strings.Join(ss, ""))
	g.P(leadingComments, oneofName, " ", goType, tags)
	sf.append(oneofName)
}

// opaqueGenMessageInternalFields adds additional XXX_ fields to a message struct.
func opaqueGenMessageInternalFields(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, sf *structFields) {
	if opaqueNeedsPresenceArray(message) {
		if opaqueNeedsLazyStruct(message) {
			g.P("// Deprecated: Do not use. This will be deleted in the near future.")
			g.P("XXX_lazyUnmarshalInfo ", protoimplPackage.Ident("LazyUnmarshalInfo"))
			sf.append("XXX_lazyUnmarshalInfo")
		}
		g.P("XXX_raceDetectHookData ", protoimplPackage.Ident("RaceDetectHookData"))
		sf.append("XXX_raceDetectHookData")

		// Presence must be stored in a data type no larger than 32 bit:
		//
		// Presence used to be a uint64, accessed with atomic.LoadUint64, but it
		// turns out that on 32-bit platforms like GOARCH=arm, the struct field
		// was 32-bit aligned (not 64-bit aligned) and hence atomic accesses
		// failed.
		//
		// The easiest solution was to switch to a uint32 on all platforms,
		// which did not come with a performance penalty.
		g.P("XXX_presence [", (opaqueNumPresenceFields(message)+31)/32, "]uint32")
		sf.append("XXX_presence")
	}
	if message.Desc.ExtensionRanges().Len() > 0 {
		g.P(genid.ExtensionFields_goname, " ", protoimplPackage.Ident("ExtensionFields"))
		sf.append(genid.ExtensionFields_goname)
	}
	g.P(genid.UnknownFields_goname, " ", protoimplPackage.Ident("UnknownFields"))
	sf.append(genid.UnknownFields_goname)
	g.P(genid.SizeCache_goname, " ", protoimplPackage.Ident("SizeCache"))
	sf.append(genid.SizeCache_goname)
}

func opaqueGenMessageMethods(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo) {
	genMessageBaseMethods(g, f, message)

	isRepeated := func(field *protogen.Field) bool {
		return field.Desc.Cardinality() == protoreflect.Repeated
	}

	for _, field := range message.Fields {
		if isFirstOneofField(field) && !message.isOpaque() {
			opaqueGenGetOneof(g, f, message, field.Oneof)
		}
		opaqueGenGet(g, f, message, field)
	}
	for _, field := range message.Fields {
		// For the plain open mode, we do not have setters.
		if message.isOpen() {
			continue
		}
		opaqueGenSet(g, f, message, field)
	}
	for _, field := range message.Fields {
		// Open API does not have Has method.
		// Repeated (includes map) fields do not have Has method.
		if message.isOpen() || isRepeated(field) {
			continue
		}

		if !field.Desc.HasPresence() {
			continue
		}

		if isFirstOneofField(field) {
			opaqueGenHasOneof(g, f, message, field.Oneof)
		}
		opaqueGenHas(g, f, message, field)
	}
	for _, field := range message.Fields {
		// Open API does not have Clear method.
		// Repeated (includes map) fields do not have Clear method.
		if message.isOpen() || isRepeated(field) {
			continue
		}
		if !field.Desc.HasPresence() {
			continue
		}

		if isFirstOneofField(field) {
			opaqueGenClearOneof(g, f, message, field.Oneof)
		}
		opaqueGenClear(g, f, message, field)
	}
	// Plain open protos do not have which methods.
	if !message.isOpen() {
		opaqueGenWhichOneof(g, f, message)
	}

	if g.InternalStripForEditionsDiff() {
		return
	}
}

func isLazy(field *protogen.Field) bool {
	// Prerequisite: field is of kind message
	if field.Message == nil {
		return false
	}

	// Was the field marked as [lazy = true] in the .proto file?
	return field.Desc.(interface{ IsLazy() bool }).IsLazy()
}

// opaqueGenGet generates a Get method for a field.
func opaqueGenGet(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, field *protogen.Field) {
	goType, pointer := opaqueFieldGoType(g, f, message, field)
	getterName, bcName := field.MethodName("Get")

	// If we need a backwards compatible getter name, we add it now.
	if bcName != "" {
		defer func() {
			g.P("// Deprecated: Use ", getterName, " instead.")
			g.P("func (x *", message.GoIdent, ") ", bcName, "() ", goType, " {")
			g.P("return x.", getterName, "()")
			g.P("}")
			g.P()
		}()
	}

	leadingComments := appendDeprecationSuffix("",
		field.Desc.ParentFile(),
		field.Desc.Options().(*descriptorpb.FieldOptions).GetDeprecated())
	fieldtrackNoInterface(g, message.isTracked)
	g.AnnotateSymbol(message.GoIdent.GoName+"."+getterName, protogen.Annotation{Location: field.Location})

	defaultValue := fieldDefaultValue(g, f, message, field)

	// Oneof field.
	if oneof := field.Oneof; oneof != nil && !oneof.Desc.IsSynthetic() {
		structPtr := "x"
		g.P(leadingComments, "func (x *", message.GoIdent, ") ", getterName, "() ", goType, " {")
		g.P("if x != nil {")
		if message.isOpaque() && message.isTracked {
			g.P("_ = ", structPtr, ".XXX_ft_", field.Oneof.GoName)
		}
		g.P("if x, ok := ", structPtr, ".", opaqueOneofFieldName(oneof, message.isOpaque()), ".(*", opaqueFieldOneofType(field, message.isOpaque()), "); ok {")
		g.P("return x.", field.GoName)
		g.P("}")
		// End if m != nil {.
		g.P("}")
		g.P("return ", defaultValue)
		g.P("}")
		g.P()
		return
	}

	// Non-oneof field for open type message.
	if !message.isOpaque() {
		g.P(leadingComments, "func (x *", message.GoIdent, ") ", getterName, "() ", goType, " {")
		if !field.Desc.HasPresence() || defaultValue == "nil" {
			g.P("if x != nil {")
		} else {
			g.P("if x != nil && x.", field.GoName, " != nil {")
		}
		star := ""
		if pointer {
			star = "*"
		}
		g.P("return ", star, " x.", field.GoName)
		g.P("}")
		g.P("return ", defaultValue)
		g.P("}")
		g.P()
		return
	}

	// Non-oneof field for opaque type message.
	g.P(leadingComments, "func (x *", message.GoIdent, ") ", getterName, "() ", goType, "{")
	structPtr := "x"
	g.P("if x != nil {")
	if message.isTracked {
		g.P("_ = ", structPtr, ".XXX_ft_", field.GoName)
	}
	if usePresence(message, field) {
		pi := opaqueFieldPresenceIndex(field)
		ai := pi / 32
		// For
		//
		//  1. Message fields of lazy messages (unmarshalled lazily),
		//  2. Fields with a default value,
		//  3. Closed enums
		//
		// ...we check presence, but for other fields using presence, we can return
		// whatever is there and it should be correct regardless of presence, which
		// saves us an atomic operation.
		isEnum := field.Desc.Kind() == protoreflect.EnumKind
		usePresenceForRead := (isLazy(field)) ||
			field.Desc.HasDefault() || isEnum

		if usePresenceForRead {
			g.P("if ", protoimplPackage.Ident("X"), ".Present(&(", structPtr, ".XXX_presence[", ai, "]),", pi, ") {")
		}
		// For lazy, check if pointer is nil and optionally unmarshal
		if isLazy(field) {
			// Since pointer to lazily unmarshaled sub-message can be written during a conceptual
			// "read" operation, all read/write accesses to the pointer must be atomic.  This
			// function gets inlined on x86 as just a simple get and compare. Still need to make the
			// slice accesses be atomic.
			g.P("if ", protoimplPackage.Ident("X"), ".AtomicCheckPointerIsNil(&", structPtr, ".xxx_hidden_", field.GoName, ") {")
			g.P(protoimplPackage.Ident("X"), ".UnmarshalField(", structPtr, ", ", field.Desc.Number(), ")")
			g.P("}")
		}
		if field.Message == nil || field.Desc.IsMap() {
			star := ""
			if pointer {
				star = "*"
			}
			if pointer {
				g.P("if ", structPtr, ".xxx_hidden_", field.GoName, "!= nil {")
			}

			g.P("return ", star, structPtr, ".xxx_hidden_", field.GoName)
			if pointer {
				g.P("}")
				g.P("return ", defaultValue)
			}
		} else {
			// We need to do an atomic load of the msg pointer field, but cannot explicitly use
			// unsafe pointers here.  We load the value and store into rv, via protoimpl.Pointer,
			// which is aliased to unsafe.Pointer in pointer_unsafe.go, but is aliased to
			// interface{} in pointer_reflect.go
			star := ""
			if pointer {
				star = "*"
			}
			if isLazy(field) {
				g.P("var rv ", star, goType)
				g.P(protoimplPackage.Ident("X"), ".AtomicLoadPointer(", protoimplPackage.Ident("Pointer"), "(&", structPtr, ".xxx_hidden_", field.GoName, "), ", protoimplPackage.Ident("Pointer"), "(&rv))")
				g.P("return ", star, "rv")
			} else {
				if pointer {
					g.P("if ", structPtr, ".xxx_hidden_", field.GoName, "!= nil {")
				}
				g.P("return ", star, structPtr, ".xxx_hidden_", field.GoName)
				if pointer {
					g.P("}")
				}
			}
		}
		if usePresenceForRead {
			g.P("}")
		}
	} else if pointer {
		g.P("if ", structPtr, ".xxx_hidden_", field.GoName, " != nil {")
		g.P("return *", structPtr, ".xxx_hidden_", field.GoName)
		g.P("}")
	} else {
		g.P("return ", structPtr, ".xxx_hidden_", field.GoName)
	}
	// End if m != nil {.
	g.P("}")
	g.P("return ", defaultValue)
	g.P("}")
	g.P()
}

// opaqueGenSet generates a Set method for a field.
func opaqueGenSet(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, field *protogen.Field) {
	goType, pointer := opaqueFieldGoType(g, f, message, field)
	setterName, bcName := field.MethodName("Set")

	// If we need a backwards compatible setter name, we add it now.
	if bcName != "" {
		defer func() {
			g.P("// Deprecated: Use ", setterName, " instead.")
			g.P("func (x *", message.GoIdent, ") ", bcName, "(v ", goType, ") {")
			g.P("x.", setterName, "(v)")
			g.P("}")
			g.P()
		}()
	}

	leadingComments := appendDeprecationSuffix("",
		field.Desc.ParentFile(),
		field.Desc.Options().(*descriptorpb.FieldOptions).GetDeprecated())
	g.AnnotateSymbol(message.GoIdent.GoName+"."+setterName, protogen.Annotation{
		Location: field.Location,
		Semantic: descriptorpb.GeneratedCodeInfo_Annotation_SET.Enum(),
	})
	fieldtrackNoInterface(g, message.noInterface)

	// Oneof field.
	if oneof := field.Oneof; oneof != nil && !oneof.Desc.IsSynthetic() {
		g.P(leadingComments, "func (x *", message.GoIdent, ") ", setterName, "(v ", goType, ") {")
		structPtr := "x"
		if message.isOpaque() && message.isTracked {
			// Add access to zero field for tracking
			g.P(structPtr, ".XXX_ft_", oneof.GoName, " = struct{}{}")
		}
		if field.Desc.Kind() == protoreflect.BytesKind {
			g.P("if v == nil { v = []byte{} }")
		} else if field.Message != nil {
			g.P("if v == nil {")
			g.P(structPtr, ".", opaqueOneofFieldName(oneof, message.isOpaque()), "= nil")
			g.P("return")
			g.P("}")
		}
		g.P(structPtr, ".", opaqueOneofFieldName(oneof, message.isOpaque()), "= &", opaqueFieldOneofType(field, message.isOpaque()), "{v}")
		g.P("}")
		g.P()
		return
	}

	// Non-oneof field for open type message.
	if !message.isOpaque() {
		g.P(leadingComments, "func (x *", message.GoIdent, ") ", setterName, "(v ", goType, ") {")
		if field.Desc.Cardinality() != protoreflect.Repeated && field.Desc.Kind() == protoreflect.BytesKind {
			g.P("if v == nil { v = []byte{} }")
		}
		amp := ""
		if pointer {
			amp = "&"
		}

		v := "v"
		g.P("x.", field.GoName, " = ", amp, v)
		g.P("}")
		g.P()
		return
	}

	// Non-oneof field for opaque type message.
	g.P(leadingComments, "func (x *", message.GoIdent, ") ", setterName, "(v ", goType, ") {")
	structPtr := "x"
	if message.isTracked {
		// Add access to zero field for tracking
		g.P(structPtr, ".XXX_ft_", field.GoName, " = struct{}{}")
	}
	if field.Desc.Cardinality() != protoreflect.Repeated && field.Desc.Kind() == protoreflect.BytesKind {
		g.P("if v == nil { v = []byte{} }")
	}
	amp := ""
	if pointer {
		amp = "&"
	}
	if usePresence(message, field) {
		pi := opaqueFieldPresenceIndex(field)
		ai := pi / 32

		if field.Message != nil && field.Desc.IsList() {
			g.P("var sv *", goType)
			g.P(protoimplPackage.Ident("X"), ".AtomicLoadPointer(", protoimplPackage.Ident("Pointer"), "(&", structPtr, ".xxx_hidden_", field.GoName, "), ", protoimplPackage.Ident("Pointer"), "(&sv))")
			g.P("if sv == nil {")
			g.P("sv = &", goType, "{}")
			g.P(protoimplPackage.Ident("X"), ".AtomicInitializePointer(", protoimplPackage.Ident("Pointer"), "(&", structPtr, ".xxx_hidden_", field.GoName, "), ", protoimplPackage.Ident("Pointer"), "(&sv))")
			g.P("}")
			g.P("*sv = v")
			g.P(protoimplPackage.Ident("X"), ".SetPresent(&(", structPtr, ".XXX_presence[", ai, "]),", pi, ",", opaqueNumPresenceFields(message), ")")
		} else if field.Message != nil && !field.Desc.IsMap() {
			// Only for lazy messages do we need to set pointers atomically
			if isLazy(field) {
				g.P(protoimplPackage.Ident("X"), ".AtomicSetPointer(&", structPtr, ".xxx_hidden_", field.GoName, ", ", amp, "v)")
			} else {
				g.P(structPtr, ".xxx_hidden_", field.GoName, " = ", amp, "v")
			}
			// When setting a message or slice of messages to a nil
			// value, we must clear the presence bit, else we will
			// later think that this field still needs to be lazily decoded.
			g.P("if v == nil {")
			g.P(protoimplPackage.Ident("X"), ".ClearPresent(&(", structPtr, ".XXX_presence[", ai, "]),", pi, ")")
			g.P("} else {")
			g.P(protoimplPackage.Ident("X"), ".SetPresent(&(", structPtr, ".XXX_presence[", ai, "]),", pi, ",", opaqueNumPresenceFields(message), ")")
			g.P("}")
		} else {
			// Any map or non-message, possibly repeated, field that uses presence (proto2 only)
			g.P(structPtr, ".xxx_hidden_", field.GoName, " = ", amp, "v")
			// For consistent behaviour with lazy fields, non-map repeated fields should be cleared when
			// the last object is removed. Maps are cleared when set to a nil map.
			if field.Desc.Cardinality() == protoreflect.Repeated { // Includes maps.
				g.P("if v == nil {")
				g.P(protoimplPackage.Ident("X"), ".ClearPresent(&(", structPtr, ".XXX_presence[", ai, "]),", pi, ")")
				g.P("} else {")
			}
			g.P(protoimplPackage.Ident("X"), ".SetPresent(&(", structPtr, ".XXX_presence[", ai, "]),", pi, ",", opaqueNumPresenceFields(message), ")")
			if field.Desc.Cardinality() == protoreflect.Repeated {
				g.P("}")
			}
		}
	} else {
		// proto3 non-lazy fields
		g.P(structPtr, ".xxx_hidden_", field.GoName, " = ", amp, "v")
	}
	g.P("}")
	g.P()
}

// usePresence returns true if the presence map should be used for a field. It
// is always true for lazy message types. It is also true for all scalar fields.
// repeated, map or message fields are not using the presence map.
func usePresence(message *messageInfo, field *protogen.Field) bool {
	if !message.isOpaque() {
		return false
	}
	usePresence, _ := filedesc.UsePresenceForField(field.Desc)
	return usePresence
}

// opaqueGenHas generates a Has method for a field.
func opaqueGenHas(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, field *protogen.Field) {
	hasserName, _ := field.MethodName("Has")

	leadingComments := appendDeprecationSuffix("",
		field.Desc.ParentFile(),
		field.Desc.Options().(*descriptorpb.FieldOptions).GetDeprecated())
	g.AnnotateSymbol(message.GoIdent.GoName+"."+hasserName, protogen.Annotation{Location: field.Location})
	fieldtrackNoInterface(g, message.noInterface)

	// Oneof field.
	if oneof := field.Oneof; oneof != nil && !oneof.Desc.IsSynthetic() {
		g.P(leadingComments, "func (x *", message.GoIdent, ") ", hasserName, "() bool {")
		structPtr := "x"
		g.P("if ", structPtr, " == nil {")
		g.P("return false")
		g.P("}")
		if message.isOpaque() && message.isTracked {
			// Add access to zero field for tracking
			g.P("_ = ", structPtr, ".", "XXX_ft_", oneof.GoName)
		}
		g.P("_, ok := ", structPtr, ".", opaqueOneofFieldName(oneof, message.isOpaque()), ".(*", opaqueFieldOneofType(field, message.isOpaque()), ")")
		g.P("return ok")
		g.P("}")
		g.P()
		return
	}

	// Non-oneof field in open message.
	if !message.isOpaque() {
		g.P(leadingComments, "func (x *", message.GoIdent, ") ", hasserName, "() bool {")
		g.P("if x == nil {")
		g.P("return false")
		g.P("}")
		g.P("return ", "x.", field.GoName, " != nil")
		g.P("}")
		g.P()
		return
	}

	// Non-oneof field in opaque message.
	g.P(leadingComments, "func (x *", message.GoIdent, ") ", hasserName, "() bool {")
	g.P("if x == nil {")
	g.P("return false")
	g.P("}")
	structPtr := "x"
	if message.isTracked {
		// Add access to zero field for tracking
		g.P("_ = ", structPtr, ".", "XXX_ft_"+field.GoName)
	}
	if usePresence(message, field) {
		pi := opaqueFieldPresenceIndex(field)
		ai := pi / 32
		g.P("return ", protoimplPackage.Ident("X"), ".Present(&(", structPtr, ".XXX_presence[", ai, "]),", pi, ")")
	} else {
		// Has for proto3 message without presence
		g.P("return ", structPtr, ".xxx_hidden_", field.GoName, " != nil")
	}

	g.P("}")
	g.P()
}

// opaqueGenClear generates a Clear method for a field.
func opaqueGenClear(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, field *protogen.Field) {
	clearerName, _ := field.MethodName("Clear")
	pi := opaqueFieldPresenceIndex(field)
	ai := pi / 32

	leadingComments := appendDeprecationSuffix("",
		field.Desc.ParentFile(),
		field.Desc.Options().(*descriptorpb.FieldOptions).GetDeprecated())
	g.AnnotateSymbol(message.GoIdent.GoName+"."+clearerName, protogen.Annotation{
		Location: field.Location,
		Semantic: descriptorpb.GeneratedCodeInfo_Annotation_SET.Enum(),
	})
	fieldtrackNoInterface(g, message.noInterface)

	// Oneof field.
	if oneof := field.Oneof; oneof != nil && !oneof.Desc.IsSynthetic() {
		g.P(leadingComments, "func (x *", message.GoIdent, ") ", clearerName, "() {")
		structPtr := "x"
		if message.isOpaque() && message.isTracked {
			// Add access to zero field for tracking
			g.P(structPtr, ".", "XXX_ft_", oneof.GoName, " = struct{}{}")
		}
		g.P("if _, ok := ", structPtr, ".", opaqueOneofFieldName(oneof, message.isOpaque()), ".(*", opaqueFieldOneofType(field, message.isOpaque()), "); ok {")
		g.P(structPtr, ".", opaqueOneofFieldName(oneof, message.isOpaque()), " = nil")
		g.P("}")
		g.P("}")
		g.P()
		return
	}

	// Non-oneof field in open message.
	if !message.isOpaque() {
		g.P(leadingComments, "func (x *", message.GoIdent, ") ", clearerName, "() {")
		g.P("x.", field.GoName, " = nil")
		g.P("}")
		g.P()
		return
	}

	// Non-oneof field in opaque message.
	g.P(leadingComments, "func (x *", message.GoIdent, ") ", clearerName, "() {")
	structPtr := "x"
	if message.isTracked {
		// Add access to zero field for tracking
		g.P(structPtr, ".", "XXX_ft_", field.GoName, " = struct{}{}")
	}

	if usePresence(message, field) {
		g.P(protoimplPackage.Ident("X"), ".ClearPresent(&(", structPtr, ".XXX_presence[", ai, "]),", pi, ")")
	}

	// Avoid needing to read the presence value in Get by ensuring that we set the
	// right zero value (unless we have an explicit default, in which case we
	// revert to presence checking in Get). Rationale: Get is called far more
	// frequently than Clear, it should be as lean as possible.
	zv := opaqueZeroValueForField(g, field)
	// For lazy, (repeated) message fields are unmarshalled lazily. Hence they are
	// assigned atomically in Getters (which are allowed to be called
	// concurrently). Due to this, historically, the code generator would use
	// atomic operations everywhere.
	//
	// TODO(b/291588964): Stop using atomic operations for non-presence fields in
	//                    write calls (Set/Clear). Concurrent reads are allowed,
	//                    but concurrent read/write or write/write are not, we
	//                    shouldn't cater to it.
	if isLazy(field) {
		goType, _ := opaqueFieldGoType(g, f, message, field)
		g.P(protoimplPackage.Ident("X"), ".AtomicSetPointer(&", structPtr, ".xxx_hidden_", field.GoName, ",(", goType, ")(", zv, "))")
	} else if !field.Desc.HasDefault() {
		g.P(structPtr, ".xxx_hidden_", field.GoName, " = ", zv)
	}
	g.P("}")
	g.P()
}

// Determine what value to set a cleared field to.
func opaqueZeroValueForField(g *protogen.GeneratedFile, field *protogen.Field) string {
	if field.Desc.Cardinality() == protoreflect.Repeated {
		return "nil"
	}
	switch field.Desc.Kind() {
	case protoreflect.StringKind:
		return "nil"
	case protoreflect.MessageKind, protoreflect.GroupKind, protoreflect.BytesKind:
		return "nil"
	case protoreflect.BoolKind:
		return "false"
	case protoreflect.EnumKind:
		return g.QualifiedGoIdent(field.Enum.Values[0].GoIdent)
	default:
		return "0"
	}
}

// opaqueGenGetOneof generates a Get function for a oneof union.
func opaqueGenGetOneof(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, oneof *protogen.Oneof) {
	ifName := opaqueOneofInterfaceName(oneof)
	g.AnnotateSymbol(message.GoIdent.GoName+".Get"+oneof.GoName, protogen.Annotation{Location: oneof.Location})
	fieldtrackNoInterface(g, message.isTracked)
	g.P("func (x *", message.GoIdent.GoName, ") Get", oneof.GoName, "() ", ifName, " {")
	g.P("if x != nil {")
	g.P("return x.", opaqueOneofFieldName(oneof, message.isOpaque()))
	g.P("}")
	g.P("return nil")
	g.P("}")
	g.P()
}

// opaqueGenHasOneof generates a Has function for a oneof union.
func opaqueGenHasOneof(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, oneof *protogen.Oneof) {
	fieldtrackNoInterface(g, message.noInterface)
	hasserName := oneof.MethodName("Has")
	g.P("func (x *", message.GoIdent, ") ", hasserName, "() bool {")
	g.P("if x == nil {")
	g.P("return false")
	g.P("}")
	structPtr := "x"
	if message.isOpaque() && message.isTracked {
		// Add access to zero field for tracking
		g.P("_ = ", structPtr, ".XXX_ft_", oneof.GoName)
	}
	g.P("return ", structPtr, ".", opaqueOneofFieldName(oneof, message.isOpaque()), " != nil")
	g.P("}")
	g.P()
}

// opaqueGenClearOneof generates a Clear function for a oneof union.
func opaqueGenClearOneof(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, oneof *protogen.Oneof) {
	fieldtrackNoInterface(g, message.noInterface)
	clearerName := oneof.MethodName("Clear")
	g.P("func (x *", message.GoIdent, ") ", clearerName, "() {")
	structPtr := "x"
	if message.isOpaque() && message.isTracked {
		// Add access to zero field for tracking
		g.P(structPtr, ".", "XXX_ft_", oneof.GoName, " = struct{}{}")
	}
	g.P(structPtr, ".", opaqueOneofFieldName(oneof, message.isOpaque()), " = nil")
	g.P("}")
	g.P()
}

// opaqueGenWhichOneof generates the Which method for each oneof union, as well as the case values for each member
// of that union.
func opaqueGenWhichOneof(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo) {
	// Go through the message, and for each field that is the first of a oneof field, dig down
	// and generate constants + the actual which method.
	oneofIndex := 0
	for _, field := range message.Fields {
		if oneof := field.Oneof; oneof != nil {
			if !isFirstOneofField(field) {
				continue
			}
			caseType := opaqueOneofCaseTypeName(oneof)
			g.P("const ", message.GoIdent.GoName, "_", oneof.GoName, "_not_set_case ", caseType, " = ", 0)
			for _, f := range oneof.Fields {
				g.AnnotateSymbol(message.GoIdent.GoName+"_"+f.GoName+"_case", protogen.Annotation{Location: f.Location})
				g.P("const ", message.GoIdent.GoName, "_", f.GoName, "_case ", caseType, " = ", f.Desc.Number())
			}
			fieldtrackNoInterface(g, message.noInterface)
			whicherName := oneof.MethodName("Which")
			g.AnnotateSymbol(message.GoIdent.GoName+"."+whicherName, protogen.Annotation{Location: oneof.Location})
			g.P("func (x *", message.GoIdent, ") ", whicherName, "() ", caseType, " {")
			g.P("if x == nil {")
			g.P("return ", message.GoIdent.GoName, "_", oneof.GoName, "_not_set_case ")
			g.P("}")
			g.P("switch x.", opaqueOneofFieldName(oneof, message.isOpaque()), ".(type) {")
			for _, f := range oneof.Fields {
				g.P("case *", opaqueFieldOneofType(f, message.isOpaque()), ":")
				g.P("return ", message.GoIdent.GoName, "_", f.GoName, "_case")
			}
			g.P("default", ":")
			g.P("return ", message.GoIdent.GoName, "_", oneof.GoName, "_not_set_case ")
			g.P("}")
			g.P("}")
			g.P()
			oneofIndex++
		}
	}
}

func opaqueNeedsPresenceArray(message *messageInfo) bool {
	if !message.isOpaque() {
		return false
	}
	for _, field := range message.Fields {
		if usePresence, _ := filedesc.UsePresenceForField(field.Desc); usePresence {
			return true
		}
	}
	return false
}

func opaqueNeedsLazyStruct(message *messageInfo) bool {
	for _, field := range message.Fields {
		if isLazy(field) {
			return true
		}
	}
	return false
}

// opaqueGenMessageBuilder generates a Builder type for a message.
func opaqueGenMessageBuilder(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo) {
	if message.isOpen() {
		return
	}
	// Builder type.
	bName := g.QualifiedGoIdent(message.GoIdent) + genid.BuilderSuffix_goname
	g.AnnotateSymbol(message.GoIdent.GoName+genid.BuilderSuffix_goname, protogen.Annotation{Location: message.Location})

	leadingComments := appendDeprecationSuffix("",
		message.Desc.ParentFile(),
		message.Desc.Options().(*descriptorpb.MessageOptions).GetDeprecated())
	g.P(leadingComments, "type ", bName, " struct {")
	g.P("_ [0]func() // Prevents comparability and use of unkeyed literals for the builder.")
	g.P()
	for _, field := range message.Fields {
		oneof := field.Oneof

		goType, pointer := opaqueBuilderFieldGoType(g, f, message, field)
		if pointer {
			goType = "*" + goType
		} else if oneof != nil && fieldDefaultValue(g, f, message, field) != "nil" {
			goType = "*" + goType
		}
		// Track all non-oneof fields. Note: synthetic oneofs are an
		// implementation detail of proto3 optional fields:
		// go/proto-proposals/proto3-presence.md, which should be tracked.
		tag := ""
		if (oneof == nil || oneof.Desc.IsSynthetic()) && message.isTracked {
			tag = "`go:\"track\"`"
		}
		if oneof != nil && oneof.Fields[0] == field && !oneof.Desc.IsSynthetic() {
			if oneof.Comments.Leading != "" {
				g.P(oneof.Comments.Leading)
				g.P()
			}
			g.P("// Fields of oneof ", opaqueOneofFieldName(oneof, message.isOpaque()), ":")
		}
		g.AnnotateSymbol(field.Parent.GoIdent.GoName+genid.BuilderSuffix_goname+"."+field.BuilderFieldName(), protogen.Annotation{Location: field.Location})
		leadingComments := appendDeprecationSuffix(field.Comments.Leading,
			field.Desc.ParentFile(),
			field.Desc.Options().(*descriptorpb.FieldOptions).GetDeprecated())
		g.P(leadingComments,
			field.BuilderFieldName(), " ", goType, " ", tag)
		if oneof != nil && oneof.Fields[len(oneof.Fields)-1] == field && !oneof.Desc.IsSynthetic() {
			g.P("// -- end of ", opaqueOneofFieldName(oneof, message.isOpaque()))
		}
	}
	g.P("}")
	g.P()

	opaqueGenBuildMethod(g, f, message, bName)
}

// opaqueGenBuildMethod generates the actual Build method for the builder
func opaqueGenBuildMethod(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, bName string) {
	// Build method on the builder type.
	fieldtrackNoInterface(g, message.noInterface)
	g.P("func (b0 ", bName, ") Build() *", message.GoIdent, " {")
	g.P("m0 := &", message.GoIdent, "{}")

	if message.isTracked {
		// Redeclare the builder and message types as local
		// defined types, so that field tracking records the
		// field uses against these types instead of the
		// original struct types.
		//
		// TODO: Actually redeclare the struct types
		// without `go:"track"` tags?
		g.P("type (notrackB ", bName, "; notrackM ", message.GoIdent, ")")
		g.P("b, x := (*notrackB)(&b0), (*notrackM)(m0)")
	} else {
		g.P("b, x := &b0, m0")
	}
	g.P("_, _ = b, x")

	for _, field := range message.Fields {
		oneof := field.Oneof
		if oneof != nil && !oneof.Desc.IsSynthetic() {
			qual := ""
			if fieldDefaultValue(g, f, message, field) != "nil" {
				qual = "*"
			}

			g.P("if b.", field.BuilderFieldName(), " != nil {")
			oneofName := opaqueOneofFieldName(oneof, message.isOpaque())
			oneofType := opaqueFieldOneofType(field, message.isOpaque())
			g.P("x.", oneofName, " = &", oneofType, "{", qual, "b.", field.BuilderFieldName(), "}")
			g.P("}")
		} else { // proto3 optional ends up here (synthetic oneof)
			qual := ""
			_, pointer := opaqueBuilderFieldGoType(g, f, message, field)
			if pointer && message.isOpaque() && !field.Desc.IsList() && field.Desc.Kind() != protoreflect.StringKind {
				qual = "*"
			} else if message.isOpaque() && field.Desc.IsList() && field.Desc.Message() != nil {
				qual = "&"
			}
			presence := usePresence(message, field)
			if presence {
				g.P("if b.", field.BuilderFieldName(), " != nil {")
			}
			if presence {
				pi := opaqueFieldPresenceIndex(field)
				g.P(protoimplPackage.Ident("X"), ".SetPresentNonAtomic(&(x.XXX_presence[", pi/32, "]),", pi, ",", opaqueNumPresenceFields(message), ")")
			}
			goName := field.GoName
			if message.isOpaque() {
				goName = "xxx_hidden_" + goName
			}
			g.P("x.", goName, " = ", qual, "b.", field.BuilderFieldName())
			if presence {
				g.P("}")
			}
		}
	}

	g.P("return m0")
	g.P("}")
	g.P()
}

// opaqueBuilderFieldGoType does the same as opaqueFieldGoType, but corrects for
// types that are different in a builder
func opaqueBuilderFieldGoType(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, field *protogen.Field) (goType string, pointer bool) {
	goType, pointer = opaqueFieldGoType(g, f, message, field)
	kind := field.Desc.Kind()

	// Use []T instead of *[]T for opaque repeated lists.
	if message.isOpaque() && field.Desc.IsList() {
		pointer = false
	}

	// Use *T for optional fields.
	optional := field.Desc.HasPresence()
	if optional &&
		kind != protoreflect.GroupKind &&
		kind != protoreflect.MessageKind &&
		kind != protoreflect.BytesKind &&
		field.Desc.Cardinality() != protoreflect.Repeated {
		pointer = true
	}

	return goType, pointer
}

func opaqueGenOneofWrapperTypes(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo) {
	// TODO: We should avoid generating these wrapper types in pure-opaque mode.
	if !message.isOpen() {
		for _, oneof := range message.Oneofs {
			if oneof.Desc.IsSynthetic() {
				continue
			}
			caseTypeName := opaqueOneofCaseTypeName(oneof)
			g.P("type ", caseTypeName, " ", protoreflectPackage.Ident("FieldNumber"))
			g.P("")

			idx := f.allMessagesByPtr[message]
			typesVar := messageTypesVarName(f)
			g.P("func (x ", caseTypeName, ") String() string {")
			g.P("md := ", typesVar, "[", idx, "].Descriptor()")
			g.P("if x == 0 {")
			g.P(`return "not set"`)
			g.P("}")
			g.P("return ", protoimplPackage.Ident("X"), ".MessageFieldStringOf(md, ", protoreflectPackage.Ident("FieldNumber"), "(x))")
			g.P("}")
			g.P()
		}
	}
	for _, oneof := range message.Oneofs {
		if oneof.Desc.IsSynthetic() {
			continue
		}
		ifName := opaqueOneofInterfaceName(oneof)
		g.P("type ", ifName, " interface {")
		g.P(ifName, "()")
		g.P("}")
		g.P()
		for _, field := range oneof.Fields {
			name := opaqueFieldOneofType(field, message.isOpaque())
			g.AnnotateSymbol(name.GoName, protogen.Annotation{Location: field.Location})
			g.AnnotateSymbol(name.GoName+"."+field.GoName, protogen.Annotation{Location: field.Location})
			g.P("type ", name, " struct {")
			goType, _ := opaqueFieldGoType(g, f, message, field)
			protobufTagValue := fieldProtobufTagValue(field)
			if g.InternalStripForEditionsDiff() {
				protobufTagValue = strings.ReplaceAll(protobufTagValue, ",proto3", "")
			}
			tags := structTags{
				{"protobuf", protobufTagValue},
			}
			leadingComments := appendDeprecationSuffix(field.Comments.Leading,
				field.Desc.ParentFile(),
				field.Desc.Options().(*descriptorpb.FieldOptions).GetDeprecated())
			g.P(leadingComments,
				field.GoName, " ", goType, tags,
				trailingComment(field.Comments.Trailing))
			g.P("}")
			g.P()
		}
		for _, field := range oneof.Fields {
			g.P("func (*", opaqueFieldOneofType(field, message.isOpaque()), ") ", ifName, "() {}")
			g.P()
		}
	}
}

// opaqueFieldGoType returns the Go type used for a field.
//
// If it returns pointer=true, the struct field is a pointer to the type.
func opaqueFieldGoType(g *protogen.GeneratedFile, f *fileInfo, message *messageInfo, field *protogen.Field) (goType string, pointer bool) {
	pointer = true
	switch field.Desc.Kind() {
	case protoreflect.BoolKind:
		goType = "bool"
	case protoreflect.EnumKind:
		goType = g.QualifiedGoIdent(field.Enum.GoIdent)
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
		goType = "int32"
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
		goType = "uint32"
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		goType = "int64"
	case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		goType = "uint64"
	case protoreflect.FloatKind:
		goType = "float32"
	case protoreflect.DoubleKind:
		goType = "float64"
	case protoreflect.StringKind:
		goType = "string"
	case protoreflect.BytesKind:
		goType = "[]byte"
		pointer = false
	case protoreflect.MessageKind, protoreflect.GroupKind:
		goType = opaqueMessageFieldGoType(g, f, field, message.isOpaque())
		pointer = false
	}
	switch {
	case field.Desc.IsList():
		goType = "[]" + goType
		pointer = false
	case field.Desc.IsMap():
		keyType, _ := opaqueFieldGoType(g, f, message, field.Message.Fields[0])
		valType, _ := opaqueFieldGoType(g, f, message, field.Message.Fields[1])
		return fmt.Sprintf("map[%v]%v", keyType, valType), false
	}

	// Extension fields always have pointer type, even when defined in a proto3 file.
	if !field.Desc.IsExtension() && !field.Desc.HasPresence() {
		pointer = false
	}

	if message.isOpaque() {
		switch {
		case field.Desc.IsList() && field.Desc.Message() != nil:
			pointer = true
		case !field.Desc.IsList() && field.Desc.Kind() == protoreflect.StringKind:
			switch {
			case field.Desc.HasPresence():
				pointer = true
			default:
				pointer = false
			}
		default:
			pointer = false
		}
	}

	return goType, pointer
}

func opaqueMessageFieldGoType(g *protogen.GeneratedFile, f *fileInfo, field *protogen.Field, isOpaque bool) string {
	return "*" + g.QualifiedGoIdent(field.Message.GoIdent)
}

// opaqueFieldPresenceIndex returns the index to pass to presence functions.
//
// TODO: field.Desc.Index() would be simpler, and would give space to record the presence of oneof fields.
func opaqueFieldPresenceIndex(field *protogen.Field) int {
	structFieldIndex := 0
	for _, f := range field.Parent.Fields {
		if field == f {
			break
		}
		if f.Oneof == nil || isLastOneofField(f) {
			structFieldIndex++
		}
	}
	return structFieldIndex
}

// opaqueNumPresenceFields returns the number of fields that may be passed to presence functions.
//
// Since all fields in a oneof currently share a single entry in the presence bitmap,
// this is not just len(message.Fields).
func opaqueNumPresenceFields(message *messageInfo) int {
	if len(message.Fields) == 0 {
		return 0
	}
	return opaqueFieldPresenceIndex(message.Fields[len(message.Fields)-1]) + 1
}

func fieldtrackNoInterface(g *protogen.GeneratedFile, isTracked bool) {
	if isTracked {
		g.P("//go:nointerface")
	}
}

// opaqueOneofFieldName returns the name of the struct field that holds
// the value of a oneof.
func opaqueOneofFieldName(oneof *protogen.Oneof, isOpaque bool) string {
	if isOpaque {
		return "xxx_hidden_" + oneof.GoName
	}
	return oneof.GoName
}

func opaqueFieldOneofType(field *protogen.Field, isOpaque bool) protogen.GoIdent {
	ident := protogen.GoIdent{
		GoImportPath: field.Parent.GoIdent.GoImportPath,
		GoName:       field.Parent.GoIdent.GoName + "_" + field.GoName,
	}
	// Check for collisions with nested messages or enums.
	//
	// This conflict resolution is incomplete: Among other things, it
	// does not consider collisions with other oneof field types.
Loop:
	for {
		for _, message := range field.Parent.Messages {
			if message.GoIdent == ident {
				ident.GoName += "_"
				continue Loop
			}
		}
		for _, enum := range field.Parent.Enums {
			if enum.GoIdent == ident {
				ident.GoName += "_"
				continue Loop
			}
		}
		return unexportIdent(ident, isOpaque)
	}
}

// unexportIdent turns id into its unexported version (by lower-casing), but
// only if isOpaque is set. This function is used for oneof wrapper types,
// which remain exported in the non-opaque API for now.
func unexportIdent(id protogen.GoIdent, isOpaque bool) protogen.GoIdent {
	if !isOpaque {
		return id
	}
	r, sz := utf8.DecodeRuneInString(id.GoName)
	if r == utf8.RuneError {
		panic(fmt.Sprintf("Go identifier %q contains invalid UTF8?!", id.GoName))
	}
	r = unicode.ToLower(r)
	id.GoName = string(r) + id.GoName[sz:]
	return id
}

func opaqueOneofInterfaceName(oneof *protogen.Oneof) string {
	return fmt.Sprintf("is%s_%s", oneof.Parent.GoIdent.GoName, oneof.GoName)
}
func opaqueOneofCaseTypeName(oneof *protogen.Oneof) string {
	return fmt.Sprintf("case_%s_%s", oneof.Parent.GoIdent.GoName, oneof.GoName)
}

// isFirstOneofField reports whether this is the first field in a oneof.
func isFirstOneofField(field *protogen.Field) bool {
	return field.Oneof != nil && field == field.Oneof.Fields[0] && !field.Oneof.Desc.IsSynthetic()
}

// isLastOneofField returns true if this is the last field in a oneof.
func isLastOneofField(field *protogen.Field) bool {
	return field.Oneof != nil && field == field.Oneof.Fields[len(field.Oneof.Fields)-1]
}
