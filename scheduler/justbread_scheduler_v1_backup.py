import tkinter as tk
from tkinter import ttk
from datetime import datetime, timedelta
import math, os, sys, subprocess, re as _re

BG, PANEL       = "#1a1a18", "#242420"
ACCENT, GREEN   = "#c8a96e", "#7a9e6e"
TEXT, MUTED     = "#f0ead8", "#7a7568"
BORDER, EBG     = "#3a3a34", "#2e2e28"
ERR             = "#c06050"
FH  = ("Georgia", 18, "bold");   FS  = ("Georgia", 9, "italic")
FL  = ("Courier New", 9, "bold"); FB  = ("Courier New", 9)
FBT = ("Courier New", 10, "bold"); FE = ("Courier New", 10)

STARTER_G  = 125; WATER_G = 243; FLOUR_G = 350; SALT_G = 12
BAG_G      = 5440; GALLON_G = 3780; SALT_BOX_G = 48 * 28.3495
DOUGH_STEPS = [
    ("Mix",0),("Add Salt",60),("Fold",80),("Laminate 1",100),
    ("Fold 1",120),("Laminate 2",145),("Fold 2",160),
    ("Rest",180),("Preshape",240),("Shape",330),("-> Fridge",450),
]
DOUGH_MIN = 450
COVERED=18*60+15; U1=5*60+10; U2=5*60+10; SWAP=5*60
PREHEAT=30*60; COOL=(2*60+30)*60; PACK=30*60
COLD_H=16; BATCH=4
DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]


def r5(dt):
    total = dt.hour*60 + dt.minute
    h, m = divmod(round(total/5)*5, 60)
    if h >= 24: h, m = 23, 55
    return dt.replace(hour=h, minute=m, second=0, microsecond=0)

def fmt(dt):
    h = dt.hour % 12 or 12
    return f"{h}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"

def grams(v):
    return f"{round(v):,}g"

def parse_t(s):
    s = s.strip().upper().replace(".","")
    for f in ["%I:%M %p","%H:%M","%I %p","%I:%M%p","%I%p"]:
        try: return datetime.strptime(s, f)
        except: pass
    raise ValueError(s)

def supply_line(total_g, unit_g, unit_name):
    full = int(total_g // unit_g)
    rem  = round(total_g % unit_g)
    total_u = math.ceil(total_g / unit_g)
    p = lambda n: f"{n} {unit_name}{'s' if n != 1 else ''}"
    if rem == 0:  return f"{p(total_u)} (exact)"
    if full == 0: return f"{p(total_u)} ({rem:,}g)"
    return f"{p(total_u)} ({p(full)} + {rem:,}g)"


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("JustBread -- Weekly Scheduler")
        self.configure(bg=BG)
        self.resizable(True, True)
        self._day_acts = {}
        self._totals   = {}
        self._build()
        self.update_idletasks()
        w = 720
        x = (self.winfo_screenwidth() - w) // 2
        self.geometry(f"{w}x800+{x}+30")

    def _build(self):
        hdr = tk.Frame(self, bg=BG, pady=12); hdr.pack(fill="x", padx=26)
        tk.Label(hdr, text="JUSTBREAD", font=FH, bg=BG, fg=ACCENT).pack(anchor="w")
        tk.Label(hdr, text="weekly production scheduler", font=FS, bg=BG, fg=MUTED).pack(anchor="w")
        tk.Frame(self, bg=ACCENT, height=1).pack(fill="x", padx=26)

        ch = tk.Frame(self, bg=BG, pady=7); ch.pack(fill="x", padx=26)
        for t, w in [("DAY",12),("LOAVES",9),("DONE BY",12)]:
            tk.Label(ch, text=t, font=FL, bg=BG, fg=MUTED, width=w, anchor="w").pack(side="left", padx=(0,4))
        tk.Label(ch, text="(when loaves are packaged & ready)", font=("Courier New",8), bg=BG, fg=MUTED).pack(side="left")
        tk.Frame(self, bg=BORDER, height=1).pack(fill="x", padx=26)

        inp = tk.Frame(self, bg=BG, pady=2); inp.pack(fill="x", padx=26)
        self.lv, self.tv = {}, {}
        self._loaf_entries, self._time_entries = [], []
        for day in DAYS:
            row = tk.Frame(inp, bg=BG, pady=3); row.pack(fill="x")
            tk.Label(row, text=day, font=FL, bg=BG, fg=TEXT, width=12, anchor="w").pack(side="left", padx=(0,4))
            lv = tk.StringVar(value="0"); self.lv[day] = lv
            le = self._ent(row, lv, 9); le.pack(side="left", padx=(0,10))
            self._loaf_entries.append(le)
            tv = tk.StringVar(value=""); self.tv[day] = tv
            te = self._ent(row, tv, 12); te.pack(side="left", padx=(0,6))
            self._time_entries.append(te)
            tk.Label(row, text="e.g. 2:00 PM", font=("Courier New",8), bg=BG, fg=MUTED).pack(side="left")

        for e in self._loaf_entries + self._time_entries:
            e.lift()

        tk.Frame(self, bg=BORDER, height=1).pack(fill="x", padx=26, pady=(6,0))
        br = tk.Frame(self, bg=BG, pady=9); br.pack()
        tk.Button(br, text="GENERATE SCHEDULE", font=FBT, bg=ACCENT, fg="#1a1a18",
                  activebackground="#d4b87a", relief="flat", bd=0, padx=18, pady=7,
                  cursor="hand2", command=self._generate).pack(side="left", padx=5)
        tk.Button(br, text="PRINT SCHEDULE", font=FBT, bg=PANEL, fg=ACCENT,
                  activebackground=BORDER, relief="flat", bd=0, padx=18, pady=7,
                  cursor="hand2", command=self._print_pdf).pack(side="left", padx=5)
        tk.Frame(self, bg=BORDER, height=1).pack(fill="x", padx=26)

        outer = tk.Frame(self, bg=BG); outer.pack(fill="both", expand=True)
        self._cv = tk.Canvas(outer, bg=BG, highlightthickness=0)
        sb = ttk.Scrollbar(outer, orient="vertical", command=self._cv.yview)
        self._ri = tk.Frame(self._cv, bg=BG)
        self._ri.bind("<Configure>", lambda e: self._cv.configure(scrollregion=self._cv.bbox("all")))
        self._cv.create_window((0,0), window=self._ri, anchor="nw")
        self._cv.configure(yscrollcommand=sb.set)
        self._cv.pack(side="left", fill="both", expand=True, padx=26, pady=8)
        sb.pack(side="right", fill="y")
        self.bind_all("<MouseWheel>", lambda e: self._cv.yview_scroll(-1*(e.delta//120),"units"))

    def _ent(self, p, v, w):
        return tk.Entry(p, textvariable=v, font=FE, bg=EBG, fg=TEXT,
                        insertbackground=ACCENT, relief="flat", width=w,
                        highlightthickness=1, highlightbackground=BORDER, highlightcolor=ACCENT)

    def _calc(self):
        active = []
        for i, day in enumerate(DAYS):
            try: n = int(self.lv[day].get())
            except: n = 0
            if n <= 0: continue
            ts = self.tv[day].get().strip()
            if not ts: return None, f"Enter 'Done by' time for {day}"
            try: done_dt = parse_t(ts)
            except: return None, f"Can't read time for {day}: '{ts}'  -- try: 2:00 PM"
            active.append((i, day, n, done_dt))
        if not active: return None, "Enter at least one day with loaves > 0"

        total_l = sum(n for _,_,n,_ in active)
        tf = total_l*FLOUR_G; tw = total_l*WATER_G
        ts_g = total_l*SALT_G; tst = total_l*STARTER_G
        fridge_pull_total = round(sum(n*STARTER_G/9 for _,_,n,_ in active))
        s_full = int(ts_g//SALT_BOX_G); s_rem = round(ts_g - s_full*SALT_BOX_G)
        s_total = math.ceil(ts_g/SALT_BOX_G)
        salt_str = f"{s_total} box{'es' if s_total!=1 else ''}"
        if s_rem > 0: salt_str += f" ({s_full} box{'es' if s_full!=1 else ''} + {s_rem}g)" if s_full else f" ({s_rem}g)"
        else: salt_str += " (exact)"

        totals = {
            "loaves": total_l, "starter": tst,
            "fridge_starter": fridge_pull_total,
            "flour": supply_line(tf, BAG_G, "bag"),
            "water": supply_line(tw, GALLON_G, "gallon"),
            "salt": f"{ts_g}g  ->  {salt_str}",
        }

        day_acts = {i: [] for i in range(7)}
        for bake_idx, bake_day, loaves, done_dt in active:
            dough_idx = (bake_idx-1) % 7
            feed_idx  = (bake_idx-2) % 7
            n_b = math.ceil(loaves/BATCH)
            per_b = COVERED+U1+U2+SWAP; last_b = COVERED+U1+U2
            last_out = done_dt - timedelta(seconds=COOL+PACK)
            first_in = last_out - timedelta(seconds=(n_b-1)*per_b+last_b)
            oven_on  = first_in - timedelta(seconds=PREHEAT)
            fridge_dt = r5(done_dt - timedelta(hours=2))
            mix_dt    = r5(fridge_dt - timedelta(minutes=DOUGH_MIN))

            bake_ev = [("Oven ON  (preheat)", r5(oven_on))]
            for i in range(n_b):
                t_in = r5(first_in + timedelta(seconds=i*per_b))
                lo, hi = i*BATCH+1, min((i+1)*BATCH, loaves)
                bake_ev.append((f"Batch {i+1} IN  ({lo}-{hi})", t_in))
            bake_ev += [("Packaging", r5(done_dt-timedelta(seconds=PACK))),
                        ("DONE", r5(done_dt))]

            stl = loaves*STARTER_G
            tag = f"{loaves} loaves -> {bake_day}"
            dough_steps = [(nm, r5(mix_dt+timedelta(minutes=off))) for nm,off in DOUGH_STEPS]

            day_acts[feed_idx].append(("starter",{
                "tag":tag,"pull":stl/9,"after1":stl/3,"total":stl,
                "sort":mix_dt.replace(hour=5,minute=0),
            }))
            day_acts[dough_idx].append(("dough",{
                "tag":tag,"steps":dough_steps,"mix":mix_dt,"fridge":fridge_dt,
                "flour":loaves*FLOUR_G,"water":loaves*WATER_G,
                "salt":loaves*SALT_G,"starter":stl,
                "bake_day":bake_day,"done_by":done_dt,"sort":mix_dt,
            }))
            day_acts[bake_idx].append(("bake",{
                "tag":tag,"events":bake_ev,"batches":n_b,
                "done_by":done_dt,"sort":r5(oven_on),
            }))

        for di in day_acts:
            day_acts[di].sort(key=lambda x: x[1].get("sort", datetime(2024,1,1,0,0)))

        return (totals, day_acts), None

    def _generate(self):
        for w in self._ri.winfo_children(): w.destroy()
        result, err = self._calc()
        if err: return self._err(err)
        totals, day_acts = result
        self._totals = totals; self._day_acts = day_acts

        self._sec("WEEKLY TOTALS")
        self._row("Total loaves",              str(totals["loaves"]))
        self._row("Starting fridge starter",   grams(totals["fridge_starter"]), bold=True)
        self._row("Total flour",               totals["flour"])
        self._row("Total water",               totals["water"])
        self._row("Total salt",                totals["salt"])
        self._div()

        for di, day in enumerate(DAYS):
            acts = day_acts[di]
            if not acts: continue
            self._sec(day.upper())
            for atype, data in acts:
                if atype == "starter":
                    self._sub(f"Starter Feeding  *  {data['tag']}")
                    self._row("AM Feed -- pull from fridge", grams(data['pull']))
                    self._row("PM Feed -- flour & water each", grams(data['after1']))
                    self._row("After PM Feed -- use for dough", grams(data['total']), hi=True)
                elif atype == "dough":
                    self._sub(f"Make Dough  *  {data['tag']}  *  start {fmt(data['mix'])}")
                    self._row("Flour",   supply_line(data['flour'], BAG_G, "bag"))
                    self._row("Water",   supply_line(data['water'], GALLON_G, "gallon"))
                    self._row("Salt",    grams(data['salt']))
                    self._row("Starter", grams(data['starter']))
                    _bold = {"Mix", "Add Salt", "Laminate 1", "Laminate 2", "Rest", "Preshape", "Shape", "-> Fridge"}
                    for nm, t in data['steps']:
                        self._row(nm, fmt(t), bold=(nm in _bold))

                elif atype == "bake":
                    self._sub(f"Bake  *  {data['tag']}  *  {data['batches']} batches  *  done by {fmt(data['done_by'])}")
                    for nm, t in data['events']:
                        self._row(nm, fmt(t), hi="DONE" in nm)
            self._div()

    def _print_pdf(self):
        if not self._day_acts:
            return self._err("Generate a schedule first.")
        import importlib.util as _ilu
        _dirs = []
        if hasattr(sys, "_MEIPASS"): _dirs.append(sys._MEIPASS)
        _dirs += [os.path.dirname(os.path.abspath(sys.argv[0])),
                  os.path.dirname(os.path.abspath(__file__)),
                  os.getcwd()]
        _pb = None
        for _d in _dirs:
            _p = os.path.join(_d, "pdf_builder.py")
            if os.path.exists(_p):
                _spec = _ilu.spec_from_file_location("pdf_builder", _p)
                _pb = _ilu.module_from_spec(_spec); _spec.loader.exec_module(_pb)
                break
        if _pb is None:
            return self._err("pdf_builder.py not found. Keep it in the same folder as this app.")
        now_str = datetime.now().strftime("%B %d, %Y  %I:%M %p")
        import threading
        def _run():
            try:
                pdf_bytes = _pb.build_pdf(
                    self._totals, self._day_acts, DAYS, DOUGH_STEPS,
                    fmt, grams, supply_line, BAG_G, GALLON_G,
                    now_str, landscape=True)
                candidates = [os.path.join(os.path.expanduser("~"),"Desktop"),
                              os.path.expanduser("~"),
                              os.path.dirname(os.path.abspath(sys.argv[0]))]
                save_dir = next((d for d in candidates if os.path.isdir(d)), ".")
                path = os.path.join(save_dir, "justbread_schedule.pdf")
                with open(path, "wb") as f:
                    f.write(pdf_bytes)
                self.after(0, lambda: [
                    tk.Label(self._ri, text=f"PDF saved -> {path}",
                             font=FB, bg=BG, fg=GREEN).pack(anchor="w", padx=12, pady=4),
                    subprocess.Popen(["cmd", "/c", "start", "", path])
                ])
            except Exception as e:
                self.after(0, lambda err=e: self._err(f"PDF failed: {err}"))
        threading.Thread(target=_run, daemon=True).start()

    def _sec(self, title):
        tk.Frame(self._ri, bg=ACCENT, height=1).pack(fill="x", pady=(10,2))
        tk.Label(self._ri, text=title, font=FBT, bg=BG, fg=ACCENT, anchor="w").pack(fill="x", padx=4)
        tk.Frame(self._ri, bg=ACCENT, height=1).pack(fill="x", pady=(2,6))

    def _sub(self, title):
        tk.Label(self._ri, text=f"  {title}", font=("Courier New",9,"bold"),
                 bg=BG, fg=GREEN, anchor="w").pack(fill="x", padx=8, pady=(8,2))

    def _row(self, label, value, hi=False, note=False, bold=False):
        row = tk.Frame(self._ri, bg=BG, pady=1); row.pack(fill="x", padx=12)
        vfg   = ACCENT if hi else (MUTED if note else TEXT)
        lfont = ("Courier New", 9, "bold") if bold else FB
        vfont = ("Courier New", 10, "bold") if (hi or bold) else FB
        tk.Label(row, text=label, font=lfont, bg=BG, fg=(TEXT if bold else MUTED),
                 width=32, anchor="w").pack(side="left")
        tk.Label(row, text=value, font=vfont, bg=BG, fg=vfg).pack(side="left")

    def _div(self):
        tk.Frame(self._ri, bg=BORDER, height=1).pack(fill="x", padx=8, pady=8)

    def _err(self, msg):
        for w in self._ri.winfo_children(): w.destroy()
        tk.Label(self._ri, text=f"!  {msg}", font=FB, bg=BG, fg=ERR,
                 justify="left", wraplength=660).pack(anchor="w", pady=10, padx=8)


if __name__ == "__main__":
    App().mainloop()
