package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"google.golang.org/protobuf/compiler/protogen"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/pluginpb"

	"github.com/SebastienMelki/sebuf/internal/openapiv3"
)

func main() {
	req := readRequest()
	format := parseFormat(req)
	plugin := createPlugin(req)
	generateOpenAPIFiles(plugin, format)
	writeResponse(plugin)
}

func readRequest() *pluginpb.CodeGeneratorRequest {
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		panic(err)
	}

	var req pluginpb.CodeGeneratorRequest
	if unmarshalErr := proto.Unmarshal(input, &req); unmarshalErr != nil {
		panic(unmarshalErr)
	}
	return &req
}

func parseFormat(req *pluginpb.CodeGeneratorRequest) openapiv3.OutputFormat {
	format := openapiv3.FormatYAML // default to YAML
	if req.Parameter != nil {
		params := parseParameters(req.GetParameter())
		if f, ok := params["format"]; ok {
			switch f {
			case "json":
				format = openapiv3.FormatJSON
			case "yaml", "yml":
				format = openapiv3.FormatYAML
			}
		}
	}
	return format
}

func createPlugin(req *pluginpb.CodeGeneratorRequest) *protogen.Plugin {
	opts := protogen.Options{}
	plugin, err := opts.New(req)
	if err != nil {
		panic(err)
	}
	return plugin
}

func generateOpenAPIFiles(plugin *protogen.Plugin, format openapiv3.OutputFormat) {
	for _, file := range plugin.Files {
		if !file.Generate {
			continue
		}
		processFileServices(plugin, file, format)
	}
}

func processFileServices(plugin *protogen.Plugin, file *protogen.File, format openapiv3.OutputFormat) {
	for _, service := range file.Services {
		generator := createServiceGenerator(file, service, format)
		output := renderService(generator)
		writeServiceFile(plugin, service, output, format)
	}
}

func createServiceGenerator(
	_ *protogen.File,
	service *protogen.Service,
	format openapiv3.OutputFormat,
) *openapiv3.Generator {
	generator := openapiv3.NewGenerator(format)

	// Collect all messages referenced by this service, including those from other files
	generator.CollectReferencedMessages(service)

	generator.ProcessService(service)
	return generator
}

func renderService(generator *openapiv3.Generator) []byte {
	output, renderErr := generator.Render()
	if renderErr != nil {
		panic(renderErr)
	}
	return output
}

func writeServiceFile(
	plugin *protogen.Plugin,
	service *protogen.Service,
	output []byte,
	format openapiv3.OutputFormat,
) {
	ext := "yaml"
	if format == openapiv3.FormatJSON {
		ext = "json"
	}
	filename := fmt.Sprintf("%s.openapi.%s", service.Desc.Name(), ext)

	generatedFile := plugin.NewGeneratedFile(filename, "")
	if _, writeErr := generatedFile.Write(output); writeErr != nil {
		panic(writeErr)
	}
}

func writeResponse(plugin *protogen.Plugin) {
	resp := plugin.Response()
	resp.SupportedFeatures = proto.Uint64(uint64(pluginpb.CodeGeneratorResponse_FEATURE_PROTO3_OPTIONAL))

	respOutput, err := proto.Marshal(resp)
	if err != nil {
		panic(err)
	}

	if _, writeErr := os.Stdout.Write(respOutput); writeErr != nil {
		panic(writeErr)
	}
}

// parseParameters parses protoc plugin parameters in the format "key=value,key2=value2".
func parseParameters(parameter string) map[string]string {
	params := make(map[string]string)
	if parameter == "" {
		return params
	}

	pairs := strings.Split(parameter, ",")
	for _, pair := range pairs {
		const splitLimit = 2
		if kv := strings.SplitN(pair, "=", splitLimit); len(kv) == splitLimit {
			params[strings.TrimSpace(kv[0])] = strings.TrimSpace(kv[1])
		}
	}
	return params
}
