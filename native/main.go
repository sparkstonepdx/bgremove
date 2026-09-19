// bgremove removes image backgrounds entirely on this machine.
//
//	bgremove serve                     drag-drop UI at http://127.0.0.1:7734
//	bgremove photo.jpg                 -> photo.cutout.png
//	bgremove -o cutouts photos/        batch a directory
//	bgremove -bg '#ffffff' photo.jpg   flatten onto a color
//
// Flags come before paths. On first run it downloads the ONNX Runtime shared library and the model
// into the user cache dir. After that it never touches the network.
package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	ort "github.com/yalue/onnxruntime_go"
)

//go:embed ui.html
var uiHTML []byte

const ortVersion = "1.23.0"

// profiles.json is the single source of truth for model settings, shared
// byte-for-byte with the wasm build so the two cannot drift apart.
//
//go:embed profiles.json
var profilesJSON []byte

type profile struct {
	URL       string     `json:"url"`
	License   string     `json:"license"`
	Mean      [3]float32 `json:"mean"`
	Std       [3]float32 `json:"std"`
	Letterbox bool       `json:"letterbox"`
	Clean     struct {
		Lo float32 `json:"lo"`
		Hi float32 `json:"hi"`
	} `json:"clean"`
	FillHoles bool   `json:"fillHoles"`
	Note      string `json:"note"`
}

type profileFile struct {
	Default string             `json:"default"`
	Models  map[string]profile `json:"models"`
}

var profiles profileFile

func init() {
	if err := json.Unmarshal(profilesJSON, &profiles); err != nil {
		panic("profiles.json: " + err.Error())
	}
}

func modelNames() []string {
	names := make([]string, 0, len(profiles.Models))
	for n := range profiles.Models {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func cacheDir() string {
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "bgremove")
	os.MkdirAll(dir, 0o755)
	return dir
}

func download(url, dest string) error {
	if _, err := os.Stat(dest); err == nil {
		return nil
	}
	log.Printf("fetching %s", url)
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("%s: %s", url, resp.Status)
	}
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	f.Close()
	return os.Rename(tmp, dest)
}

// ---------------------------------------------------------------- runtime

// ensureRuntime returns a path to the ONNX Runtime shared library, fetching
// the official build for this platform if it is not cached yet.
func ensureRuntime() (string, error) {
	var asset, libName string
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "linux/amd64":
		asset, libName = "onnxruntime-linux-x64-"+ortVersion+".tgz", "libonnxruntime.so"
	case "linux/arm64":
		asset, libName = "onnxruntime-linux-aarch64-"+ortVersion+".tgz", "libonnxruntime.so"
	case "darwin/amd64", "darwin/arm64":
		asset, libName = "onnxruntime-osx-universal2-"+ortVersion+".tgz", "libonnxruntime.dylib"
	case "windows/amd64":
		asset, libName = "onnxruntime-win-x64-"+ortVersion+".zip", "onnxruntime.dll"
	default:
		return "", fmt.Errorf("no prebuilt onnxruntime for %s/%s; pass -ort with your own build", runtime.GOOS, runtime.GOARCH)
	}

	lib := filepath.Join(cacheDir(), libName)
	if _, err := os.Stat(lib); err == nil {
		return lib, nil
	}

	pkg := filepath.Join(cacheDir(), asset)
	url := "https://github.com/microsoft/onnxruntime/releases/download/v" + ortVersion + "/" + asset
	if err := download(url, pkg); err != nil {
		return "", err
	}
	if err := extractLib(pkg, libName, lib); err != nil {
		return "", err
	}
	return lib, nil
}

func extractLib(pkg, libName, dest string) error {
	write := func(r io.Reader) error {
		f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(f, r)
		return err
	}

	if strings.HasSuffix(pkg, ".zip") {
		zr, err := zip.OpenReader(pkg)
		if err != nil {
			return err
		}
		defer zr.Close()
		for _, f := range zr.File {
			if filepath.Base(f.Name) == libName {
				rc, err := f.Open()
				if err != nil {
					return err
				}
				defer rc.Close()
				return write(rc)
			}
		}
		return fmt.Errorf("%s not found in %s", libName, pkg)
	}

	f, err := os.Open(pkg)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		// the real library is the versioned file; the plain name is a symlink
		base := filepath.Base(h.Name)
		if h.Typeflag == tar.TypeReg && strings.HasPrefix(base, libName) {
			return write(tr)
		}
	}
	return fmt.Errorf("%s not found in %s", libName, pkg)
}

// ---------------------------------------------------------------- model

type Segmenter struct {
	session *ort.DynamicAdvancedSession
	w, h    int64

	mean, std [3]float32

	// Alpha below CleanLo becomes fully transparent and above CleanHi fully
	// opaque, with a ramp between. Without this the model's low-confidence
	// tail leaves a faint ghost of the background across the whole frame.
	CleanLo, CleanHi float32

	// Letterbox pads the image to a square before scaling, so the subject
	// reaches the model undistorted. Worth ~14 points of IoU for isnet and
	// costs u2net dearly, which was trained on squashed input.
	Letterbox bool

	// FillHoles makes enclosed background inside the subject opaque, which
	// recovers dark printed areas the model reads as background.
	FillHoles bool
}

func NewSegmenter(modelName, ortPath string) (*Segmenter, error) {
	p, ok := profiles.Models[modelName]
	if !ok {
		return nil, fmt.Errorf("unknown model %q; have %s", modelName, strings.Join(modelNames(), ", "))
	}
	path := filepath.Join(cacheDir(), modelName+".onnx")
	if err := download(p.URL, path); err != nil {
		return nil, err
	}

	if ortPath == "" {
		var err error
		if ortPath, err = ensureRuntime(); err != nil {
			return nil, err
		}
	}
	ort.SetSharedLibraryPath(ortPath)
	if !ort.IsInitialized() {
		if err := ort.InitializeEnvironment(); err != nil {
			return nil, err
		}
	}

	ins, outs, err := ort.GetInputOutputInfo(path)
	if err != nil {
		return nil, err
	}
	dims := ins[0].Dimensions // 1 x 3 x H x W
	if len(dims) != 4 {
		return nil, fmt.Errorf("unexpected input shape %v", dims)
	}

	// these nets emit several side outputs; the first is the finest mask
	sess, err := ort.NewDynamicAdvancedSession(path,
		[]string{ins[0].Name}, []string{outs[0].Name}, nil)
	if err != nil {
		return nil, err
	}
	return &Segmenter{
		session:   sess,
		h:         dims[2],
		w:         dims[3],
		mean:      p.Mean,
		std:       p.Std,
		CleanLo:   p.Clean.Lo,
		CleanHi:   p.Clean.Hi,
		Letterbox: p.Letterbox,
		FillHoles: p.FillHoles,
	}, nil
}

func (s *Segmenter) Close() { s.session.Destroy() }

// Prediction is the model's raw output for one image, normalised to 0..1 and
// still at the model's own resolution. Shaping it into a mask is separate and
// cheap, which is what lets the tuner sweep thousands of settings on a handful
// of inferences.
type Prediction struct {
	Data   []float32
	W, H   int
	Bounds image.Rectangle // the source image's size
	Off    image.Point     // letterbox offset, zero when squashing
	Feed   image.Rectangle // what the model actually saw
}

// Predict runs the model. This is the expensive half.
func (s *Segmenter) Predict(src image.Image) (*Prediction, error) {
	b := src.Bounds()
	feed, off := src, image.Point{}
	if s.Letterbox {
		feed, off = padSquare(src)
	}

	small := resize(feed, int(s.w), int(s.h))
	n := s.w * s.h
	data := make([]float32, 3*n)

	i := 0
	for y := 0; y < int(s.h); y++ {
		for x := 0; x < int(s.w); x++ {
			r, g, bl, _ := small.At(x, y).RGBA()
			px := [3]float32{float32(r >> 8), float32(g >> 8), float32(bl >> 8)}
			for c := 0; c < 3; c++ {
				data[int64(c)*n+int64(i)] = (px[c]/255 - s.mean[c]) / s.std[c]
			}
			i++
		}
	}

	in, err := ort.NewTensor(ort.NewShape(1, 3, s.h, s.w), data)
	if err != nil {
		return nil, err
	}
	defer in.Destroy()
	out, err := ort.NewEmptyTensor[float32](ort.NewShape(1, 1, s.h, s.w))
	if err != nil {
		return nil, err
	}
	defer out.Destroy()

	if err := s.session.Run([]ort.Value{in}, []ort.Value{out}); err != nil {
		return nil, err
	}

	pred := out.GetData()
	lo, hi := pred[0], pred[0]
	for _, v := range pred {
		if v < lo {
			lo = v
		}
		if v > hi {
			hi = v
		}
	}
	span := hi - lo
	if span == 0 {
		span = 1
	}

	norm := make([]float32, len(pred))
	for j, v := range pred {
		norm[j] = (v - lo) / span
	}
	return &Prediction{
		Data: norm, W: int(s.w), H: int(s.h),
		Bounds: b, Off: off, Feed: feed.Bounds(),
	}, nil
}

// Shape applies the ramp and hole filling at the model's resolution. This is
// the cheap half, and the only part the tuner varies.
func (s *Segmenter) Shape(p *Prediction) *image.Alpha {
	clean := s.CleanHi - s.CleanLo
	mask := image.NewAlpha(image.Rect(0, 0, p.W, p.H))
	for j, v := range p.Data {
		a := v
		if clean > 0 {
			a = (a - s.CleanLo) / clean
		}
		mask.Pix[j] = uint8(clampf32(a, 0, 1) * 255)
	}
	if s.FillHoles {
		fillHoles(mask)
	}
	return mask
}

// Scale brings a shaped mask up to the source image's size, undoing any
// letterbox padding.
func (p *Prediction) Scale(mask *image.Alpha) *image.Alpha {
	full := resizeMask(mask, p.Feed.Dx(), p.Feed.Dy())
	if p.Off.X == 0 && p.Off.Y == 0 && p.Feed.Dx() == p.Bounds.Dx() && p.Feed.Dy() == p.Bounds.Dy() {
		return full
	}
	cut := image.NewAlpha(image.Rect(0, 0, p.Bounds.Dx(), p.Bounds.Dy()))
	for y := 0; y < p.Bounds.Dy(); y++ {
		copy(cut.Pix[y*cut.Stride:(y+1)*cut.Stride],
			full.Pix[(y+p.Off.Y)*full.Stride+p.Off.X:])
	}
	return cut
}

// Mask runs the model and returns an alpha mask at the source image's size.
func (s *Segmenter) Mask(src image.Image) (*image.Alpha, error) {
	p, err := s.Predict(src)
	if err != nil {
		return nil, err
	}
	return p.Scale(s.Shape(p)), nil
}

// padSquare centres src on a black square, so scaling to the model's square
// input does not stretch the subject. Black beats grey or white here: the
// models read a flat dark border as background rather than as part of a scene.
func padSquare(src image.Image) (image.Image, image.Point) {
	b := src.Bounds()
	side := b.Dx()
	if b.Dy() > side {
		side = b.Dy()
	}
	off := image.Point{(side - b.Dx()) / 2, (side - b.Dy()) / 2}
	pad := image.NewRGBA(image.Rect(0, 0, side, side))
	draw.Draw(pad, pad.Bounds(), image.NewUniform(color.Black), image.Point{}, draw.Src)
	draw.Draw(pad, image.Rect(off.X, off.Y, off.X+b.Dx(), off.Y+b.Dy()), src, b.Min, draw.Src)
	return pad, off
}

// fillHoles makes transparent regions that do not touch the border opaque.
// A dark logo printed on the subject reads as background to these models and
// comes out as a see-through patch without this.
func fillHoles(m *image.Alpha) {
	w, h := m.Bounds().Dx(), m.Bounds().Dy()
	outside := make([]bool, w*h)
	queue := make([]int32, 0, w*h/4)

	push := func(x, y int) {
		if x < 0 || y < 0 || x >= w || y >= h {
			return
		}
		i := y*w + x
		if outside[i] || m.Pix[y*m.Stride+x] >= 128 {
			return
		}
		outside[i] = true
		queue = append(queue, int32(i))
	}

	for x := 0; x < w; x++ {
		push(x, 0)
		push(x, h-1)
	}
	for y := 0; y < h; y++ {
		push(0, y)
		push(w-1, y)
	}
	for len(queue) > 0 {
		i := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		x, y := int(i)%w, int(i)/w
		push(x-1, y)
		push(x+1, y)
		push(x, y-1)
		push(x, y+1)
	}

	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if !outside[y*w+x] && m.Pix[y*m.Stride+x] < 128 {
				m.Pix[y*m.Stride+x] = 255
			}
		}
	}
}

// Cutout returns src with the background made transparent, optionally
// composited onto a solid color.
func (s *Segmenter) Cutout(src image.Image, bg color.Color) (image.Image, error) {
	mask, err := s.Mask(src)
	if err != nil {
		return nil, err
	}
	b := src.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.DrawMask(out, out.Bounds(), src, b.Min, mask, image.Point{}, draw.Over)
	if bg != nil {
		flat := image.NewNRGBA(out.Bounds())
		draw.Draw(flat, flat.Bounds(), &image.Uniform{bg}, image.Point{}, draw.Src)
		draw.Draw(flat, flat.Bounds(), out, image.Point{}, draw.Over)
		return flat, nil
	}
	return out, nil
}

// ---------------------------------------------------------------- scaling

// resize does box-average downscaling and bilinear upscaling into RGBA.
func resize(src image.Image, w, h int) *image.RGBA {
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	sx := float64(b.Dx()) / float64(w)
	sy := float64(b.Dy()) / float64(h)

	for y := 0; y < h; y++ {
		y0 := b.Min.Y + int(float64(y)*sy)
		y1 := b.Min.Y + int(float64(y+1)*sy)
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for x := 0; x < w; x++ {
			x0 := b.Min.X + int(float64(x)*sx)
			x1 := b.Min.X + int(float64(x+1)*sx)
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var rs, gs, bs, n uint32
			for yy := y0; yy < y1 && yy < b.Max.Y; yy++ {
				for xx := x0; xx < x1 && xx < b.Max.X; xx++ {
					r, g, bl, _ := src.At(xx, yy).RGBA()
					rs += r >> 8
					gs += g >> 8
					bs += bl >> 8
					n++
				}
			}
			if n == 0 {
				n = 1
			}
			dst.SetRGBA(x, y, color.RGBA{uint8(rs / n), uint8(gs / n), uint8(bs / n), 255})
		}
	}
	return dst
}

// resizeMask upscales a mask bilinearly so edges stay smooth.
func resizeMask(src *image.Alpha, w, h int) *image.Alpha {
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	dst := image.NewAlpha(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		fy := (float64(y)+0.5)*float64(sh)/float64(h) - 0.5
		y0 := clampi(int(fy), 0, sh-1)
		y1 := clampi(y0+1, 0, sh-1)
		wy := fy - float64(y0)
		for x := 0; x < w; x++ {
			fx := (float64(x)+0.5)*float64(sw)/float64(w) - 0.5
			x0 := clampi(int(fx), 0, sw-1)
			x1 := clampi(x0+1, 0, sw-1)
			wx := fx - float64(x0)

			p := func(xi, yi int) float64 { return float64(src.Pix[yi*src.Stride+xi]) }
			top := p(x0, y0)*(1-wx) + p(x1, y0)*wx
			bot := p(x0, y1)*(1-wx) + p(x1, y1)*wx
			dst.Pix[y*dst.Stride+x] = uint8(clampf(top*(1-wy)+bot*wy, 0, 255))
		}
	}
	return dst
}

func clampi(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clampf32(v, lo, hi float32) float32 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clampf(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func parseHex(s string) (color.Color, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "#")
	if len(s) == 3 {
		s = string([]byte{s[0], s[0], s[1], s[1], s[2], s[2]})
	}
	if len(s) != 6 {
		return nil, fmt.Errorf("bad color %q, want #rrggbb", s)
	}
	v, err := strconv.ParseUint(s, 16, 32)
	if err != nil {
		return nil, err
	}
	return color.NRGBA{uint8(v >> 16), uint8(v >> 8), uint8(v), 255}, nil
}

// ---------------------------------------------------------------- server

func serve(addr string, seg *Segmenter) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(uiHTML)
	})
	mux.HandleFunc("/cutout", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "post an image", http.StatusMethodNotAllowed)
			return
		}
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		file, hdr, err := r.FormFile("image")
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		defer file.Close()

		src, _, err := image.Decode(file)
		if err != nil {
			http.Error(w, "cannot read that image: "+err.Error(), http.StatusBadRequest)
			return
		}
		var bg color.Color
		if hex := r.FormValue("bg"); hex != "" {
			if bg, err = parseHex(hex); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}

		start := time.Now()
		out, err := seg.Cutout(src, bg)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		log.Printf("%s %dx%d in %s", hdr.Filename,
			src.Bounds().Dx(), src.Bounds().Dy(), time.Since(start).Round(time.Millisecond))

		var buf bytes.Buffer
		if err := png.Encode(&buf, out); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Write(buf.Bytes())
	})

	log.Printf("bgremove at http://%s  (ctrl-c to stop)", addr)
	return http.ListenAndServe(addr, mux)
}

// ---------------------------------------------------------------- cli

func main() {
	log.SetFlags(0)
	var (
		modelName = flag.String("model", "", "one of: "+strings.Join(modelNames(), ", ")+"; default from profiles.json")
		outDir    = flag.String("o", "", "output directory (batch mode)")
		bgHex     = flag.String("bg", "", "flatten onto a color, e.g. #ffffff")
		ortPath   = flag.String("ort", "", "path to your own libonnxruntime")
		addr      = flag.String("addr", "127.0.0.1:7734", "address for serve mode")
		clean     = flag.String("clean", "", "alpha ramp lo,hi; below lo goes transparent, above hi opaque; default comes from profiles.json")
		fit       = flag.String("fit", "", "squash or letterbox; default depends on the model")
		noFill    = flag.Bool("no-fill", false, "leave enclosed transparent patches inside the subject")
	)
	flag.Parse()

	var bg color.Color
	if *bgHex != "" {
		var err error
		if bg, err = parseHex(*bgHex); err != nil {
			log.Fatal(err)
		}
	}

	if *modelName == "" {
		*modelName = profiles.Default
	}
	seg, err := NewSegmenter(*modelName, *ortPath)
	if err != nil {
		log.Fatal(err)
	}
	if *clean != "" {
		if _, err := fmt.Sscanf(*clean, "%f,%f", &seg.CleanLo, &seg.CleanHi); err != nil {
			log.Fatalf("-clean wants two numbers like 0.3,0.7: %v", err)
		}
		if seg.CleanHi <= seg.CleanLo {
			log.Fatal("-clean needs hi greater than lo")
		}
	}
	switch *fit {
	case "":
	case "squash":
		seg.Letterbox = false
	case "letterbox":
		seg.Letterbox = true
	default:
		log.Fatal("-fit wants squash or letterbox")
	}
	if *noFill {
		seg.FillHoles = false
	}
	defer seg.Close()

	args := flag.Args()
	if len(args) == 0 || args[0] == "serve" {
		log.Fatal(serve(*addr, seg))
	}

	for _, arg := range args {
		info, err := os.Stat(arg)
		if err != nil {
			log.Fatal(err)
		}
		var files []string
		if info.IsDir() {
			entries, _ := os.ReadDir(arg)
			for _, e := range entries {
				switch strings.ToLower(filepath.Ext(e.Name())) {
				case ".jpg", ".jpeg", ".png", ".gif":
					files = append(files, filepath.Join(arg, e.Name()))
				}
			}
			if *outDir == "" {
				*outDir = filepath.Join(arg, "cutouts")
			}
		} else {
			files = []string{arg}
		}
		if *outDir != "" {
			os.MkdirAll(*outDir, 0o755)
		}

		for _, path := range files {
			start := time.Now()
			f, err := os.Open(path)
			if err != nil {
				log.Fatal(err)
			}
			src, _, err := image.Decode(f)
			f.Close()
			if err != nil {
				log.Printf("%s: %v", path, err)
				continue
			}
			out, err := seg.Cutout(src, bg)
			if err != nil {
				log.Fatal(err)
			}

			stem := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
			dest := stem + ".cutout.png"
			if *outDir != "" {
				dest = filepath.Join(*outDir, stem+".png")
			} else {
				dest = filepath.Join(filepath.Dir(path), dest)
			}
			w, err := os.Create(dest)
			if err != nil {
				log.Fatal(err)
			}
			if err := png.Encode(w, out); err != nil {
				log.Fatal(err)
			}
			w.Close()
			log.Printf("%s -> %s  %s", path, dest, time.Since(start).Round(time.Millisecond))
		}
	}
}
