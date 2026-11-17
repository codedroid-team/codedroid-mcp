// The one stylesheet shared by every e2e page. Light by default, dark through prefers-color-scheme.
export const CSS = `
:root{color-scheme:light dark;--bg:#f6f6f3;--fg:#1c2226;--muted:#566069;--card:#fff;--line:#d8dce0;--link:#0a5aa8;
--pass-bg:#dff3e5;--pass-fg:#124a26;--fail-bg:#fbe3e3;--fail-fg:#821a1a;--warn-bg:#fdf0cc;--warn-fg:#5f3d00;--info-bg:#e9edf1;--info-fg:#34404a;--code:#eef0f2}
@media (prefers-color-scheme: dark){:root{--bg:#14181c;--fg:#e4e8eb;--muted:#a1abb4;--card:#1c2227;--line:#34404a;--link:#7ab8f2;
--pass-bg:#16391f;--pass-fg:#b6eac7;--fail-bg:#471a1c;--fail-fg:#ffc8c8;--warn-bg:#3e3210;--warn-fg:#ffe09a;--info-bg:#2a333b;--info-fg:#d0d7dd;--code:#262e35}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--link)}
a:focus-visible,summary:focus-visible,input:focus-visible+label{outline:2px solid var(--link);outline-offset:2px}
.top{position:sticky;top:0;z-index:2;background:var(--card);border-bottom:1px solid var(--line)}
.top nav{max-width:52rem;margin:0 auto;padding:.4rem 1rem;display:flex;flex-wrap:wrap;gap:.25rem .5rem}
.top a,.top span{padding:.25rem .6rem;border-radius:6px;text-decoration:none;font-size:.95rem;color:var(--fg)}
.top a[aria-current]{background:var(--info-bg);font-weight:600}
.top span{color:var(--muted)}
main{max-width:52rem;margin:0 auto;padding:1rem 1rem 3rem}
footer{max-width:52rem;margin:0 auto;padding:0 1rem 2rem;color:var(--muted);font-size:.85rem}
h1{font-size:1.6rem;line-height:1.25;margin:.8rem 0 .3rem}
h2{font-size:1.25rem;margin:2rem 0 .6rem;scroll-margin-top:3.5rem}
h3{font-size:1.05rem;margin:1.2rem 0 .4rem}
h4,h5,h6{font-size:1rem;margin:1rem 0 .3rem}
.lede,.muted{color:var(--muted)}
.lede{margin:.2rem 0 1rem}
.banner{margin:.8rem 0;padding:.7rem .9rem;border:1px solid var(--warn-fg);border-radius:8px;background:var(--warn-bg);color:var(--warn-fg)}
.banner a{color:inherit;font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem 1rem;margin:.8rem 0;scroll-margin-top:3.5rem}
.card.problems{border-color:var(--fail-fg)}
.card h2,.card h3{margin-top:0}
.card .card{background:transparent;margin:.7rem 0 0;padding:.6rem .8rem}
.head{display:flex;flex-wrap:wrap;gap:.3rem .5rem;align-items:baseline}
.head h2,.head h3{margin:0;flex:1 1 14rem}
.chips{display:inline-flex;flex-wrap:wrap;gap:.3rem;align-items:center}
.chip{display:inline-block;padding:0 .5rem;border-radius:999px;font-size:.78rem;line-height:1.5;white-space:nowrap;background:var(--info-bg);color:var(--info-fg);border:1px solid var(--line)}
.chip.pass{background:var(--pass-bg);color:var(--pass-fg)}
.chip.fail{background:var(--fail-bg);color:var(--fail-fg)}
.chip.warn{background:var(--warn-bg);color:var(--warn-fg)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(10rem,1fr));gap:.6rem;margin:.8rem 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.6rem .8rem}
.tile b{display:block;font-size:1.35rem;line-height:1.3}
.tile small{color:var(--muted)}
.bar{height:6px;border-radius:3px;background:var(--info-bg);margin-top:.3rem;overflow:hidden}
.bar span{display:block;height:100%;background:var(--link)}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:.2rem .8rem;margin:.5rem 0}
dl.meta dt{color:var(--muted)}
dl.meta dd{margin:0;min-width:0;overflow-wrap:anywhere}
.scroll{overflow-x:auto;margin:.6rem 0;max-width:100%}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;vertical-align:top;padding:.35rem .6rem;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
th{color:var(--muted);font-weight:600;font-size:.82rem;overflow-wrap:normal}
.nw{white-space:nowrap}
code,pre{font:.85em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:4px}
code{padding:.05rem .3rem}
pre{padding:.6rem .8rem;overflow-x:auto}
pre code{padding:0;background:none}
ul,ol{padding-left:1.4rem;margin:.4rem 0}
li{margin:.15rem 0}
ul.plain{list-style:none;padding:0}
.gallery{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-start}
.gallery figure{position:relative;margin:0;width:300px;max-width:100%}
.gallery figure:has(.zoom:checked){width:100%}
.gallery figcaption{margin-bottom:.3rem}
.gallery img{display:block;width:300px;max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;cursor:zoom-in}
.zoom{position:absolute;opacity:0;width:1px;height:1px}
.zoom:checked+label img{width:auto;max-width:100%;cursor:zoom-out}
@media (max-width:30rem){dl.meta{grid-template-columns:1fr}dl.meta dt{margin-top:.3rem}}
@media print{.top{position:static}.card,figure,tr{break-inside:avoid}.scroll{overflow:visible}body{background:#fff;color:#000}}
`;
