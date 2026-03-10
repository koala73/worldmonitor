package main

import (
	"flag"

	"google.golang.org/protobuf/compiler/protogen"
	"google.golang.org/protobuf/types/pluginpb"

	"github.com/SebastienMelki/sebuf/internal/httpgen"
)

func main() {
	var flags flag.FlagSet
	var generateMock bool
	flags.BoolVar(&generateMock, "generate_mock", false, "generate mock server implementation")

	options := protogen.Options{
		ParamFunc: flags.Set,
	}

	options.Run(func(plugin *protogen.Plugin) error {
		plugin.SupportedFeatures = uint64(pluginpb.CodeGeneratorResponse_FEATURE_PROTO3_OPTIONAL)
		opts := httpgen.Options{
			GenerateMock: generateMock,
		}
		gen := httpgen.NewWithOptions(plugin, opts)
		return gen.Generate()
	})
}
