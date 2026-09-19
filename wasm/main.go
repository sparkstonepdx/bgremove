// bgremove serves a background remover that runs entirely in the browser.
//
//	bgremove              start on http://127.0.0.1:7734 and open it
//	bgremove -addr :7734  bind elsewhere
//	bgremove -dir out/    write a standalone copy of the site and exit
//
// The page, the ONNX Runtime WASM build and the model are compiled into this
// binary. Nothing is fetched at runtime and no image leaves the machine. No
// cgo, so it cross-compiles anywhere Go does.
package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

//go:embed web
var content embed.FS

//go:embed web/profiles.json
var profilesJSON []byte

type profile struct {
	URL   string `json:"url"`
	Bytes int64  `json:"bytes"`
}

type profileFile struct {
	Default string             `json:"default"`
	Models  map[string]profile `json:"models"`
}

// ensureModel returns a reader for the chosen model. u2netp is compiled in;
// anything else is fetched once into the user cache dir, so the binary stays
// small while the page can still run the best model.
func ensureModel(name string, table profileFile) (string, error) {
	if name == "u2netp" {
		return "", nil // served from the embedded web/ tree
	}
	p, ok := table.Models[name]
	if !ok {
		return "", fmt.Errorf("unknown model %q", name)
	}
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "bgremove")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	dest := filepath.Join(dir, name+".onnx")
	if st, err := os.Stat(dest); err == nil && st.Size() > 0 {
		return dest, nil
	}

	log.Printf("fetching %s (%d MB, once)", name, p.Bytes/(1<<20))
	resp, err := http.Get(p.URL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("%s: %s", p.URL, resp.Status)
	}
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return "", err
	}
	f.Close()
	return dest, os.Rename(tmp, dest)
}

// crossOriginIsolate turns on SharedArrayBuffer, which the runtime needs for
// multi-threaded inference. Without these two headers it falls back to one
// thread and runs several times slower.
func crossOriginIsolate(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		h.ServeHTTP(w, r)
	})
}

func main() {
	log.SetFlags(0)
	addr := flag.String("addr", "127.0.0.1:7734", "address to listen on")
	dir := flag.String("dir", "", "write the site to this directory and exit")
	model := flag.String("model", "", "model to serve; default comes from web/profiles.json")
	flag.Parse()

	var table profileFile
	if err := json.Unmarshal(profilesJSON, &table); err != nil {
		log.Fatal(err)
	}
	if *model == "" {
		*model = table.Default
	}
	modelPath, err := ensureModel(*model, table)
	if err != nil {
		log.Fatal(err)
	}

	site, err := fs.Sub(content, "web")
	if err != nil {
		log.Fatal(err)
	}

	if *dir != "" {
		if err := export(site, *dir); err != nil {
			log.Fatal(err)
		}
		log.Printf("wrote the site to %s", *dir)
		log.Printf("serve it with the two COOP/COEP headers set, or it will run single-threaded")
		return
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/config.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"model": *model})
	})
	if modelPath != "" {
		mux.HandleFunc("/model.onnx", func(w http.ResponseWriter, r *http.Request) {
			http.ServeFile(w, r, modelPath)
		})
	} else {
		mux.HandleFunc("/model.onnx", func(w http.ResponseWriter, r *http.Request) {
			data, err := fs.ReadFile(site, "u2netp.onnx")
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write(data)
		})
	}
	mux.Handle("/", http.FileServer(http.FS(site)))

	log.Printf("bgremove at http://%s  serving %s  (ctrl-c to stop)", *addr, *model)
	log.Fatal(http.ListenAndServe(*addr, crossOriginIsolate(mux)))
}

func export(site fs.FS, dir string) error {
	return fs.WalkDir(site, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(site, path)
		if err != nil {
			return err
		}
		dest := filepath.Join(dir, path)
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dest, data, 0o644)
	})
}
