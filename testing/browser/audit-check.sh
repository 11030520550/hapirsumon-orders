#!/usr/bin/env bash
# Read-only integrity check: file signatures, PDF structure, UTF-8 text. Prints status, size, path.
check() {
  local f="$1" sz r sig tl lower
  sz=$(stat -c %s "$f")
  lower=$(printf '%s' "$f" | tr 'A-Z' 'a-z')
  case "$lower" in
    *.png) sig=$(head -c 8 "$f" | od -An -tx1 | tr -d ' \n')
           if [ "$sig" = "89504e470d0a1a0a" ]; then r="OK-PNG"; else r="BAD-PNG"; fi ;;
    *.jpg|*.jpeg) sig=$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n'); tl=$(tail -c 2 "$f" | od -An -tx1 | tr -d ' \n')
           if [ "$sig" = "ffd8ff" ] && [ "$tl" = "ffd9" ]; then r="OK-JPG"; else r="CHECK-JPG:$sig/$tl"; fi ;;
    *.pdf) if head -c 5 "$f" | grep -q '%PDF-' && tail -c 2048 "$f" | grep -aq '%%EOF'; then r="OK-PDF"; else r="BAD-PDF"; fi ;;
    *.html|*.js|*.css|*.md|*.sql|*.ps1|*.json|*_headers|*.txt)
           if iconv -f UTF-8 -t UTF-8 "$f" >/dev/null 2>&1; then r="OK-UTF8"; else r="BAD-UTF8"; fi ;;
    *) r="OTHER" ;;
  esac
  printf '%-14s %10s  %s\n' "$r" "$sz" "$f"
}
for f in "$@"; do [ -f "$f" ] && check "$f"; done
