// Exercises the WASI host: staged file round trip, tty_size import, a clock
// poll (time.Sleep) and a blocking read on the keyboard ring. Built by
// build.sh; run through spikes/wasi-check.ts.
package main

import (
	"bufio"
	"fmt"
	"os"
	"time"
	"unsafe"
)

//go:wasmimport cyberspace tty_size
func ttySize(p unsafe.Pointer) int32

//go:wasmimport cyberspace tty_raw
func ttyRaw(on int32)

func main() {
	wd, _ := os.Getwd()
	fmt.Printf("cwd=%s\n", wd)

	var size [2]uint16
	if ttySize(unsafe.Pointer(&size[0])) == 0 {
		fmt.Printf("tty=%dx%d\n", size[0], size[1])
	} else {
		fmt.Println("tty=none")
	}

	if len(os.Args) > 1 {
		name := os.Args[1]
		data, err := os.ReadFile(name)
		if err != nil {
			fmt.Printf("read %s: %v\n", name, err)
		} else {
			fmt.Printf("read %s: %d bytes\n", name, len(data))
		}
		out := append(data, []byte("appended\n")...)
		if err := os.WriteFile(name, out, 0o644); err != nil {
			fmt.Printf("write %s: %v\n", name, err)
		} else {
			fmt.Printf("wrote %s: %d bytes\n", name, len(out))
		}
	}
	if len(os.Args) > 2 {
		if err := os.WriteFile(os.Args[2], []byte("new file\n"), 0o644); err != nil {
			fmt.Printf("create %s: %v\n", os.Args[2], err)
		} else {
			fmt.Printf("created %s\n", os.Args[2])
		}
	}

	t := time.Now()
	time.Sleep(50 * time.Millisecond)
	fmt.Printf("slept=%dms\n", time.Since(t).Milliseconds())

	ttyRaw(1)
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	ttyRaw(0)
	fmt.Printf("line=%q\n", line)
}
