// cowsay for wasm32-wasi. Demo cargo for the machine's wasm runner.
package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

const maxWidth = 38

func main() {
	var text string
	if len(os.Args) > 1 {
		text = strings.Join(os.Args[1:], " ")
	} else {
		var lines []string
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			lines = append(lines, sc.Text())
		}
		text = strings.Join(lines, " ")
	}
	if strings.TrimSpace(text) == "" {
		text = "moo?"
	}

	var lines []string
	for _, word := range strings.Fields(text) {
		if n := len(lines); n > 0 && len(lines[n-1])+1+len(word) <= maxWidth {
			lines[n-1] += " " + word
		} else {
			lines = append(lines, word)
		}
	}

	w := 0
	for _, l := range lines {
		if len(l) > w {
			w = len(l)
		}
	}

	fmt.Println(" " + strings.Repeat("_", w+2))
	for i, l := range lines {
		open, close := "|", "|"
		if len(lines) == 1 {
			open, close = "<", ">"
		} else if i == 0 {
			open, close = "/", "\\"
		} else if i == len(lines)-1 {
			open, close = "\\", "/"
		}
		fmt.Printf("%s %-*s %s\n", open, w, l, close)
	}
	fmt.Println(" " + strings.Repeat("-", w+2))
	fmt.Println(`        \   ^__^`)
	fmt.Println(`         \  (oo)\_______`)
	fmt.Println(`            (__)\       )\/\`)
	fmt.Println(`                ||----w |`)
	fmt.Println(`                ||     ||`)
}
