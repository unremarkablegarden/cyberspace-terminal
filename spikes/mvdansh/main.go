// Feasibility probe: mvdan/sh parser + interpreter compiled to js/wasm.
// Measures bundle size and proves the interp runs in a JS host.
// The real integration needs exec/open/stat handlers bridged to the VFS.
package main

import (
	"context"
	"strings"
	"syscall/js"

	"mvdan.cc/sh/v3/interp"
	"mvdan.cc/sh/v3/syntax"
)

func run(this js.Value, args []js.Value) any {
	src := args[0].String()
	file, err := syntax.NewParser().Parse(strings.NewReader(src), "probe")
	if err != nil {
		return "parse error: " + err.Error()
	}
	var out strings.Builder
	r, err := interp.New(interp.StdIO(nil, &out, &out))
	if err != nil {
		return "interp error: " + err.Error()
	}
	if err := r.Run(context.Background(), file); err != nil {
		out.WriteString("run: " + err.Error())
	}
	return out.String()
}

func main() {
	js.Global().Set("shProbe", js.FuncOf(run))
	select {}
}
