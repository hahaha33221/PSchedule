#!/usr/bin/env python3
"""묵주 데이터베이스(xlsx) → rosary-import 용 JSON (표준 출력)

    python3 tools/rosary-xlsx-to-json.py "(대외비) 묵주 데이터베이스_v0.3.xlsx" > /안전한/곳/rosary.json

  - 봉사자 세례명·연락처는 넣지 않음 (수도회 담당자·전화·주소는 넣음: --contacts 로 반영할 때만 씀)
  - 나온 JSON 에는 이름·연락처가 들어 있으니 저장소·공유 폴더에 두지 말고, 쓰고 나면 지움
  - 반영: ssh … 'docker compose exec -T api node server/admin.mjs rosary-import --dry' < rosary.json
"""
import datetime
import json
import sys

import openpyxl


def day(v):
    if isinstance(v, datetime.datetime):
        return v.date().isoformat()
    if isinstance(v, datetime.date):
        return v.isoformat()
    s = str(v or "").strip()[:10]
    return s if len(s) == 10 and s[4] == "-" else ""


def hm(v):
    if isinstance(v, datetime.time):
        return v.strftime("%H:%M")
    if isinstance(v, datetime.datetime):
        return v.strftime("%H:%M")
    s = str(v or "").strip()
    if len(s) == 4 and s[1] == ":":
        s = "0" + s
    return s[:5] if len(s) >= 5 and s[2] == ":" else ""


def num(v):
    if v is None or str(v).strip() in ("", "-"):
        return None
    try:
        f = float(str(v).replace(",", "").strip())
    except ValueError:
        return None
    return int(round(f))


def txt(v):
    return "" if v is None else str(v).strip()


def rows(ws):
    it = ws.iter_rows(values_only=True)
    head = [txt(c) for c in next(it)]
    for r in it:
        d = {head[i]: r[i] for i in range(min(len(head), len(r))) if head[i]}
        yield d


def main(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    out = {"schedules": [], "roster": [], "ledger": [], "participation": [], "other": []}

    for d in rows(wb["수업일정DB"]):
        code, org = txt(d.get("교육회차")), txt(d.get("수도회명"))
        if not code.startswith("S") or not org:
            continue
        helpers = [txt(d.get(f"진행봉사자{i}")) for i in range(1, 5)]
        out["schedules"].append({
            "no": num(d.get("번호")), "code": code, "date": day(d.get("수업일자")),
            "timeList": hm(d.get("수업시간(명단)")), "timeTable": hm(d.get("수업시간(일정표)")),
            "org": org, "contactName": " ".join(x for x in (txt(d.get("담당자")), txt(d.get("세례명"))) if x),
            "phone": txt(d.get("전화번호")), "address": txt(d.get("장소(명단)")), "region": txt(d.get("지역(일정표)")),
            "qtyList": num(d.get("신청수량(명단)")), "qtyTable": num(d.get("수량(일정표)")), "alloc": num(d.get("배당물량(출납)")),
            "helpers": [x for x in helpers if x], "status": txt(d.get("진행상태")),
        })

    kinds = {"묵주 만들기 봉사자": "making", "실 자르기 봉사자": "cutting"}
    for d in rows(wb["봉사자명단"]):
        call, name = txt(d.get("일정표 호칭")), txt(d.get("이름"))
        if not (call or name):
            continue
        out["roster"].append({"call": call or name, "name": name, "kind": kinds.get(txt(d.get("구분")), "etc"), "affiliation": txt(d.get("소속"))})

    for d in rows(wb["출납DB"]):
        org, date = txt(d.get("수도회명(DB)")), day(d.get("수업일자(DB)"))
        if not org or not date:
            continue
        out["ledger"].append({
            "org": org, "date": date, "alloc": num(d.get("배당물량")), "thread": num(d.get("자른실 지급")), "cross": num(d.get("십자가 지급")),
            "sendThread": num(d.get("보낼 실(기재)")), "sendCross": num(d.get("보낼 십자가(기재)")),
            "done": num(d.get("완성묵주")), "sample": num(d.get("샘플묵주")), "loss": num(d.get("로스")),
            "handler": txt(d.get("담당봉사자")), "note": txt(d.get("비고")), "check": txt(d.get("검증")),
        })

    for d in rows(wb["봉사자참여DB"]):
        code, who = txt(d.get("교육회차")), txt(d.get("참여자"))
        if code.startswith("S") and who:
            out["participation"].append({"code": code, "date": day(d.get("수업일자")), "call": who, "role": txt(d.get("구분")), "status": txt(d.get("진행상태"))})

    for d in rows(wb["기타일정"]):
        date = day(d.get("일자"))
        if date:
            out["other"].append({"date": date, "time": hm(d.get("시간")), "title": txt(d.get("내용"))})

    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
