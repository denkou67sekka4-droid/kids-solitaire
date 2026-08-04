#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
建築・換気口業界 情報収集アプリ (Kenchiku / Kankiko Intelligence Desk)

デスクトップ完結型の業務用アプリケーション。
- 追加パッケージ不要（Python 3.9+ 標準ライブラリのみで動作）
- データは実行ファイルと同じ場所の SQLite ファイルに保存
- ローカル Web UI（127.0.0.1 バインド）で管理

設計原則（要件そのまま実装）
  1. 正本は収集した原文データ。AI要約は派生データとして別テーブルに隔離する。
  2. 情報元URL / 取得日時 / 公開日 / 原文（HTML・テキスト）を必ず保存する。
  3. AIの推測は事実として保存しない。AI出力は原文からの逐語引用による
     根拠検証（grounding）を通ったものだけ「検証済」と表示する。
  4. 同一情報は正規化URLのSHA-256で重複登録しない。
  5. 再取得時に本文が変化したら差分（unified diff）を版として残す。
  6. エビデンス（URL・取得日時・原文）を追跡できない情報は採用しない。
  7. robots.txt / Crawl-delay / アクセス間隔を必ず尊重する。
  8. 会員限定情報や認証回避は行わない（401/403 は即時停止し再試行しない）。

使い方:
    python3 kanki_intel.py serve        # 管理画面を開く（既定）
    python3 kanki_intel.py collect      # 収集を1回実行（OSのスケジューラ用）
    python3 kanki_intel.py export --format csv --days 7 --out report.csv
    python3 kanki_intel.py selftest     # 内蔵の自己診断
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import difflib
import gzip
import hashlib
import http.cookies
import http.server
import io
import json
import mimetypes
import os
import re
import socket
import socketserver
import sqlite3
import ssl
import sys
import threading
import time
import traceback
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
import uuid
import webbrowser
import zlib
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from xml.etree import ElementTree

APP_NAME = "建築・換気口業界 情報収集デスク"
APP_SLUG = "kanki-intel"
APP_VERSION = "1.0.0"
SCHEMA_VERSION = 1
CLASSIFIER_VERSION = "rule-2026.08"
PROMPT_VERSION = "summarize-ja-v1"

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("KANKI_INTEL_HOME") or os.path.join(APP_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "kanki_intel.sqlite3")
EXPORT_DIR = os.path.join(DATA_DIR, "export")

JST = dt.timezone(dt.timedelta(hours=9), "JST")

DEFAULT_USER_AGENT = (
    "KankiIntelDesk/{ver} (business research crawler; contact: {contact})"
)
# HTTPヘッダは latin-1 でしかエンコードできないため、既定値もASCIIにしておく。
DEFAULT_CONTACT = "contact-not-configured"

# 1リクエストあたりの上限。過大なページを掴んで固まらないための保険。
MAX_FETCH_BYTES = 4 * 1024 * 1024
MAX_STORED_HTML_BYTES = 2 * 1024 * 1024
MAX_STORED_TEXT_CHARS = 400_000
HTTP_TIMEOUT_SEC = 25
ROBOTS_CACHE_SEC = 6 * 3600

# SimHash(64bit) のハミング距離がこの値以下なら近似重複の候補とみなす。
# 実測: 語尾違い/転載は 7-9、内容が異なる記事は 24 以上に分布するため 12 を境界にしている。
NEAR_DUPLICATE_MAX_DISTANCE = 12

# ---------------------------------------------------------------------------
# 既定設定（settings テーブルに保存され、管理画面から変更できる）
# ---------------------------------------------------------------------------
DEFAULT_SETTINGS = {
    "contact": "",                       # User-Agent に載せる連絡先（必須運用）
    "min_interval_sec": "5",             # 同一ホストへの最小アクセス間隔（秒）
    "max_pages_per_source": "12",        # 1情報源1回あたりの最大取得ページ数
    "respect_robots": "1",               # robots.txt を尊重（既定=有効、無効化は非推奨）
    "schedule_enabled": "0",
    "schedule_time": "07:30",            # 毎日自動収集の実行時刻（ローカル時刻）
    "retention_days": "0",               # 0 = 原文を無期限保持
    "ai_enabled": "0",
    "ai_model": "",                      # モデルIDは運用者が設定（既定値は持たない）
    "ai_effort": "low",
    "ai_max_chars": "12000",             # AIへ渡す原文抜粋の最大文字数
    "ai_auto_on_collect": "0",           # 収集後に高スコア案件だけ自動要約
    "ai_auto_min_score": "70",
    "priority_regions": "東京都,埼玉県,千葉県,神奈川県,茨城県,栃木県,群馬県",
    "operator": "",                      # 監査ログに残す担当者名
}

# 環境変数からのみ読む（DBには保存しない）
API_KEY_ENV = "ANTHROPIC_API_KEY"

# ===========================================================================
# 分類辞書
#   ここは「AIではなく決定論的なルール」で分類するための語彙定義。
#   分類結果は CLASSIFIER_VERSION と一緒に保存され、後から再現・再計算できる。
# ===========================================================================

# --- 優先地域（関東） -------------------------------------------------------
PRIORITY_REGIONS = ["東京都", "埼玉県", "千葉県", "神奈川県", "茨城県", "栃木県", "群馬県"]

REGION_TERMS = {
    "東京都": ["東京都", "東京", "都内", "23区", "千代田区", "中央区", "港区", "新宿区",
             "文京区", "台東区", "墨田区", "江東区", "品川区", "目黒区", "大田区",
             "世田谷区", "渋谷区", "中野区", "杉並区", "豊島区", "北区", "荒川区",
             "板橋区", "練馬区", "足立区", "葛飾区", "江戸川区", "八王子", "町田",
             "立川", "武蔵野", "三鷹", "府中市", "調布"],
    "埼玉県": ["埼玉県", "埼玉", "さいたま市", "川口市", "川越市", "所沢市", "越谷市",
             "草加市", "春日部市", "上尾市", "熊谷市", "戸田市", "和光市", "朝霞市"],
    "千葉県": ["千葉県", "千葉市", "船橋市", "松戸市", "市川市", "柏市", "浦安市",
             "習志野市", "流山市", "八千代市", "木更津市", "成田市", "幕張"],
    "神奈川県": ["神奈川県", "神奈川", "横浜市", "川崎市", "相模原市", "藤沢市",
              "横須賀市", "厚木市", "大和市", "平塚市", "茅ヶ崎市", "海老名市", "みなとみらい"],
    "茨城県": ["茨城県", "茨城", "水戸市", "つくば市", "日立市", "ひたちなか市",
             "土浦市", "古河市", "取手市", "守谷市", "神栖市"],
    "栃木県": ["栃木県", "栃木", "宇都宮市", "小山市", "足利市", "栃木市", "那須塩原市", "佐野市"],
    "群馬県": ["群馬県", "群馬", "前橋市", "高崎市", "太田市", "伊勢崎市", "桐生市", "館林市"],
}

NATIONWIDE_TERMS = [
    "全国", "国土交通省", "国交省", "経済産業省", "経産省", "建築基準法", "省エネ基準",
    "建築物省エネ法", "改正", "告示", "政令", "日本建築学会", "全国展開", "全社",
]

# --- 建築関連案件・業界情報の分類（要件 2-1） -------------------------------
PROJECT_CATEGORIES = {
    "マンション新築計画": ["マンション新築", "分譲マンション", "新築マンション", "共同住宅新築",
                    "レジデンス計画", "マンション計画", "タワーマンション"],
    "集合住宅": ["集合住宅", "共同住宅", "賃貸住宅", "アパート", "社宅", "寮", "サービス付き高齢者向け住宅",
             "サ高住", "UR賃貸", "公営住宅", "団地"],
    "大型建築・箱物": ["大規模建築", "大型施設", "箱物", "延べ面積", "延床面積", "高層ビル", "超高層"],
    "病院": ["病院", "医療センター", "クリニック", "医療施設", "診療所", "介護老人保健施設", "特別養護老人ホーム"],
    "学校": ["学校", "小学校", "中学校", "高等学校", "大学", "校舎", "体育館", "保育園", "幼稚園", "認定こども園"],
    "公共施設": ["市役所", "区役所", "町役場", "庁舎", "公民館", "図書館", "市民会館", "文化ホール",
             "消防署", "警察署", "公共施設", "浄水場", "クリーンセンター", "清掃工場"],
    "商業施設": ["商業施設", "ショッピングセンター", "ショッピングモール", "百貨店", "スーパーマーケット",
             "店舗新築", "複合商業", "アウトレット"],
    "物流施設": ["物流施設", "物流センター", "倉庫", "配送センター", "マルチテナント型物流", "冷凍冷蔵倉庫"],
    "ホテル": ["ホテル", "宿泊施設", "旅館", "リゾート施設"],
    "工場": ["工場", "生産拠点", "製造拠点", "プラント", "研究所", "研究開発拠点"],
    "オフィスビル": ["オフィスビル", "事務所ビル", "貸事務所", "業務ビル", "本社ビル"],
    "再開発": ["再開発", "再開発事業", "市街地再開発", "区画整理", "都市計画決定", "都市再生特別地区",
            "エリア開発", "再整備"],
    "改修工事": ["改修工事", "リニューアル工事", "リノベーション", "更新工事", "設備改修", "空調改修"],
    "大規模修繕": ["大規模修繕", "長期修繕計画", "修繕工事", "外壁改修"],
    "建替え": ["建替え", "建て替え", "建替", "解体新築", "除却"],
    "ゼネコン受注情報": ["受注", "受注しました", "施工者決定", "特定建設工事共同企業体", "JV", "元請",
                 "大成建設", "鹿島建設", "清水建設", "大林組", "竹中工務店", "長谷工", "前田建設",
                 "戸田建設", "西松建設", "五洋建設", "熊谷組", "安藤ハザマ", "フジタ", "奥村組"],
    "設計事務所プロジェクト": ["設計者", "基本設計", "実施設計", "設計監理", "設計事務所",
                    "日建設計", "三菱地所設計", "久米設計", "梓設計", "山下設計", "石本建築事務所"],
    "入札情報": ["入札公告", "入札公示", "一般競争入札", "指名競争入札", "公募型プロポーザル",
             "総合評価落札方式", "入札説明書", "参加資格"],
    "落札情報": ["落札", "落札者", "落札金額", "契約締結", "契約の相手方", "開札結果"],
    "着工情報": ["着工", "起工式", "工事着手", "地鎮祭", "工事開始"],
    "竣工情報": ["竣工", "完成", "しゅん工", "引渡し", "オープン", "開業"],
    "法改正（建築設備・換気）": ["建築基準法", "改正建築基準法", "建築物省エネ法", "省エネ基準適合",
                     "シックハウス", "24時間換気", "換気設備基準", "告示改正", "施行規則",
                     "防火設備", "特定天井", "定期報告"],
    "建材・部材供給": ["供給", "調達", "資材価格", "鋼材価格", "断熱材", "建材", "サプライチェーン",
                "納入", "値上げ", "原材料"],
}

# --- メーカー情報の分類（要件 3） -------------------------------------------
MAKER_CATEGORIES = {
    "新製品": ["新製品", "新発売", "新商品", "発売開始", "販売開始", "ラインアップ追加", "新シリーズ"],
    "製品リニューアル": ["リニューアル", "刷新", "モデルチェンジ", "改良", "新仕様"],
    "仕様変更": ["仕様変更", "仕様を変更", "スペック変更", "設計変更"],
    "型番変更": ["型番変更", "品番変更", "形番変更", "型式変更", "新型番", "新品番"],
    "寸法変更": ["寸法変更", "サイズ変更", "寸法を変更", "外形寸法"],
    "材質変更": ["材質変更", "素材変更", "材質を変更", "ステンレス化", "樹脂化"],
    "性能変更": ["性能変更", "性能向上", "圧力損失", "有効開口面積", "風量特性", "遮音性能", "防火性能"],
    "価格改定": ["価格改定", "価格変更", "値上げ", "値下げ", "希望小売価格", "定価改定", "プライス改定"],
    "見積停止": ["見積停止", "見積り停止", "見積受付停止", "見積対応の停止"],
    "受注停止": ["受注停止", "受注中止", "受注休止", "受注を停止"],
    "出荷停止": ["出荷停止", "出荷中止", "出荷調整", "出荷を停止"],
    "生産停止": ["生産停止", "生産中止", "製造中止", "生産終了"],
    "販売終了": ["販売終了", "販売中止", "取扱終了", "販売を終了"],
    "廃番": ["廃番", "廃版", "廃止品", "生産完了品", "ディスコン"],
    "後継品": ["後継品", "後継機種", "代替品", "推奨代替", "切替品"],
    "納期変更": ["納期変更", "納期遅延", "納期延長", "リードタイム", "納期回答", "納期遅れ"],
    "供給不足": ["供給不足", "品薄", "欠品", "在庫僅少", "調達難", "供給遅延"],
    "カタログ更新": ["カタログ", "総合カタログ", "カタログ改訂", "カタログ発行"],
    "価格表更新": ["価格表", "プライスリスト", "見積書式", "価格一覧"],
    "CADデータ更新": ["CADデータ", "CAD", "DXF", "DWG", "図面データ"],
    "BIMデータ更新": ["BIM", "Revit", "IFC", "BIMオブジェクト", "BIMデータ"],
    "技術資料公開": ["技術資料", "技術情報", "施工要領", "取扱説明書", "設計資料", "試験成績書", "性能評定"],
    "承認図更新": ["承認図", "提出図", "製作図", "納入仕様書"],
    "施工事例": ["施工事例", "採用事例", "導入事例", "納入事例", "物件紹介"],
    "展示会": ["展示会", "出展", "見本市", "ブース", "内覧会", "展示商談会"],
    "プレスリリース": ["プレスリリース", "ニュースリリース", "報道発表", "お知らせ"],
    "生産体制変更": ["工場", "生産体制", "生産拠点", "増産", "減産", "ライン増設", "工場移転", "生産移管"],
    "法改正対応": ["法改正対応", "基準適合", "認定取得", "大臣認定", "型式認定", "規格改正", "JIS改正"],
    "会社ニュース": ["組織変更", "人事", "決算", "資本業務提携", "M&A", "社名変更", "本社移転", "適時開示"],
    "業界動向": ["業界動向", "市場動向", "統計", "出荷実績", "需要予測", "景況"],
}

# --- 優先監視メーカー（要件 2-2） -------------------------------------------
WATCH_MAKERS = {
    "メルコエアテック": ["メルコエアテック", "メルコ エアテック", "MELCO AIRTECH", "melcoairtech"],
    "シルファー": ["シルファー", "SILPHA", "silpha"],
    "西邦工業": ["西邦工業", "西邦", "SEIHO", "seiho"],
    "大佐": ["大佐", "株式会社大佐", "ダイサ"],
    "宇佐美工業": ["宇佐美工業", "宇佐美", "USAMI", "usami"],
    "バクマ工業": ["バクマ工業", "バクマ", "BAKUMA", "bakuma"],
    "更科製作所": ["更科製作所", "更科", "SARASHINA", "sarashina"],
    "ナスタ": ["ナスタ", "NASTA", "nasta", "キョーワナスタ"],
}

# 上記以外でも、この商品分野に触れていれば候補として収集する（要件 2-2 後段）
PRODUCT_TERMS = {
    "換気口": ["換気口", "換気孔"],
    "給気口": ["給気口", "自然給気"],
    "排気口": ["排気口", "排気フード"],
    "差圧式給気口": ["差圧式給気口", "差圧給気", "差圧式"],
    "自然給気口": ["自然給気口", "自然給気"],
    "レジスター": ["レジスター", "レジスタ"],
    "ガラリ": ["ガラリ", "ギャラリー"],
    "ベントキャップ": ["ベントキャップ", "ベンドキャップ", "vent cap"],
    "ウェザーカバー": ["ウェザーカバー", "ウエザーカバー", "weather cover"],
    "防火ダンパー": ["防火ダンパー", "防火ダンパ", "FD", "防火区画貫通"],
    "防音製品": ["防音", "消音", "遮音", "サイレンサー"],
    "換気スリーブ": ["換気スリーブ", "スリーブ", "貫通スリーブ"],
    "電動シャッター": ["電動シャッター", "電動ダンパー", "モーターダンパー"],
    "換気設備部材": ["換気設備", "換気部材", "ダクト", "換気システム", "24時間換気", "換気ユニット"],
}

# --- 情報源の信頼度ティア（要件 4） -----------------------------------------
SOURCE_TIERS = {
    1: "メーカー・企業・発注者の公式サイト",
    2: "官公庁・自治体・公共機関",
    3: "建築・設備関連の業界団体",
    4: "建設業界の専門媒体",
    5: "上場企業のIR・適時開示",
    6: "信頼性を確認できる報道機関",
}

# 正本情報源に使用しないドメイン／URLパターン（要件 4 後段）
DENY_SOURCE_PATTERNS = [
    r"(^|\.)5ch\.net$", r"(^|\.)2ch\.sc$", r"(^|\.)open2ch\.net$",
    r"(^|\.)bakusai\.com$", r"(^|\.)matome\.naver\.jp$",
    r"(^|\.)ameblo\.jp$", r"(^|\.)hatenablog\.com$", r"(^|\.)fc2\.com$",
    r"(^|\.)livedoor\.blog$", r"(^|\.)blog\.jp$", r"(^|\.)note\.com$",
    r"(^|\.)seesaa\.net$", r"(^|\.)exblog\.jp$", r"(^|\.)goo\.ne\.jp$",
    r"(^|\.)x\.com$", r"(^|\.)twitter\.com$", r"(^|\.)facebook\.com$",
    r"(^|\.)instagram\.com$", r"(^|\.)tiktok\.com$",
    r"(^|\.)togetter\.com$", r"(^|\.)matome\.", r"(^|\.)antenna\.",
]

# 一次情報とみなせるドメインの語（二次情報から一次情報を探索する際に使う）
PRIMARY_HINT_TLDS = (".go.jp", ".lg.jp", ".ac.jp", ".or.jp")

# 差分に現れたら重要とみなす語（版の change_kinds に記録する）
CHANGE_SIGNAL_TERMS = [
    "廃番", "販売終了", "生産中止", "生産終了", "受注停止", "出荷停止", "見積停止",
    "価格改定", "値上げ", "値下げ", "納期", "後継品", "代替品", "型番", "品番",
    "仕様変更", "寸法", "材質", "供給", "欠品", "在庫",
    "落札", "入札", "着工", "竣工", "受注", "改正",
]

# スコア加点対象の高価値カテゴリ
HIGH_VALUE_CATEGORIES = {
    "廃番", "販売終了", "生産停止", "受注停止", "出荷停止", "見積停止",
    "価格改定", "後継品", "納期変更", "供給不足", "型番変更", "仕様変更",
    "入札情報", "落札情報", "着工情報", "マンション新築計画", "再開発",
    "ゼネコン受注情報", "法改正（建築設備・換気）", "法改正対応",
}

# ===========================================================================
# 共通ユーティリティ
# ===========================================================================


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(dt_obj: dt.datetime | None) -> str | None:
    if dt_obj is None:
        return None
    if dt_obj.tzinfo is None:
        dt_obj = dt_obj.replace(tzinfo=dt.timezone.utc)
    return dt_obj.astimezone(dt.timezone.utc).isoformat(timespec="seconds")


def now_iso() -> str:
    return iso(now_utc())


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_text(text: str) -> str:
    """本文比較・引用照合のための正規化。全角半角と空白の揺れを吸収する。"""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("　", " ")
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def compress(data: bytes | None) -> bytes | None:
    if data is None:
        return None
    return zlib.compress(data[:MAX_STORED_HTML_BYTES], 6)


def decompress(blob: bytes | None) -> bytes:
    if not blob:
        return b""
    try:
        return zlib.decompress(blob)
    except zlib.error:
        return b""


def ascii_header_value(text: str, fallback: str = "", limit: int = 120) -> str:
    """
    HTTPヘッダに載せられる形（latin-1 で表現できる範囲）へ整える。
    設定画面に日本語の連絡先が入力されると urllib がヘッダを組み立てられず
    全ての取得が失敗するため、送出前に必ずここを通す。
    """
    text = unicodedata.normalize("NFKC", str(text or ""))
    cleaned = "".join(ch for ch in text if 32 <= ord(ch) < 127)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ;,")
    return cleaned[:limit] or fallback


def host_of(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def is_denied_source(url: str) -> str | None:
    """正本情報源に使用できないURLなら理由を返す。使用できるなら None。"""
    host = host_of(url)
    if not host:
        return "URLからホスト名を判定できません"
    for pattern in DENY_SOURCE_PATTERNS:
        if re.search(pattern, host):
            return f"除外対象のドメインです（匿名掲示板/まとめ/個人ブログ/SNS等）: {host}"
    return None


def canonicalize_url(url: str, base: str | None = None) -> str:
    """重複判定に使う正規化URL。トラッキングパラメータと fragment を除去する。"""
    if base:
        url = urllib.parse.urljoin(base, url)
    url = url.strip()
    parts = urllib.parse.urlsplit(url)
    scheme = (parts.scheme or "https").lower()
    netloc = parts.netloc.lower()
    if netloc.endswith(":80") and scheme == "http":
        netloc = netloc[:-3]
    if netloc.endswith(":443") and scheme == "https":
        netloc = netloc[:-4]
    query_pairs = [
        (k, v)
        for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        if not k.lower().startswith(("utm_", "fbclid", "gclid", "yclid", "_ga", "mc_cid", "mc_eid"))
    ]
    query = urllib.parse.urlencode(sorted(query_pairs))
    path = parts.path or "/"
    if len(path) > 1 and path.endswith("/index.html"):
        path = path[: -len("index.html")]
    return urllib.parse.urlunsplit((scheme, netloc, path, query, ""))


def simhash64(text: str) -> str:
    """近似重複検出用の簡易 SimHash（64bit）。文字3-gram のハッシュを合成する。"""
    text = re.sub(r"\s+", "", normalize_text(text))
    if len(text) < 6:
        return "0" * 16
    vector = [0] * 64
    for i in range(len(text) - 2):
        gram = text[i : i + 3]
        digest = int.from_bytes(hashlib.md5(gram.encode("utf-8")).digest()[:8], "big")
        for bit in range(64):
            vector[bit] += 1 if (digest >> bit) & 1 else -1
    value = 0
    for bit in range(64):
        if vector[bit] > 0:
            value |= 1 << bit
    return f"{value:016x}"


def hamming_hex(a: str, b: str) -> int:
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except (ValueError, TypeError):
        return 64


# ===========================================================================
# データベース
# ===========================================================================

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 情報源管理（要件 5-1）
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_key TEXT NOT NULL UNIQUE,       -- 情報源ID（人間可読の一意キー）
    name TEXT NOT NULL,                    -- 対象名
    maker TEXT,                            -- メーカー名（該当する場合）
    domain TEXT NOT NULL DEFAULT 'construction',  -- construction | maker | both
    url TEXT NOT NULL DEFAULT '',           -- 監視対象URL
    source_type TEXT NOT NULL DEFAULT 'html',     -- rss | html | html_list
    tier INTEGER NOT NULL DEFAULT 1,        -- 情報源の優先順位（1-6）
    region TEXT NOT NULL DEFAULT '',        -- 主たる対象地域
    category_hint TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    url_verified INTEGER NOT NULL DEFAULT 0,      -- 運用者がURLの正当性を確認済みか
    terms_url TEXT NOT NULL DEFAULT '',
    terms_confirmed INTEGER NOT NULL DEFAULT 0,   -- 利用規約の確認済みフラグ
    terms_confirmed_by TEXT NOT NULL DEFAULT '',
    terms_confirmed_at TEXT,
    crawl_interval_min INTEGER NOT NULL DEFAULT 1440,
    min_interval_sec INTEGER NOT NULL DEFAULT 5,
    max_pages INTEGER NOT NULL DEFAULT 12,
    link_filter TEXT NOT NULL DEFAULT '',   -- html_list で追跡するリンクの正規表現
    note TEXT NOT NULL DEFAULT '',
    http_etag TEXT,
    http_last_modified TEXT,
    last_fetch_at TEXT,
    last_status TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    consecutive_errors INTEGER NOT NULL DEFAULT 0,
    robots_decision TEXT NOT NULL DEFAULT '',
    robots_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 収集実行の単位
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_key TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL,                     -- manual | scheduled | cli
    started_at TEXT NOT NULL,
    finished_at TEXT,
    sources_total INTEGER NOT NULL DEFAULT 0,
    sources_ok INTEGER NOT NULL DEFAULT 0,
    sources_skipped INTEGER NOT NULL DEFAULT 0,
    sources_error INTEGER NOT NULL DEFAULT 0,
    docs_new INTEGER NOT NULL DEFAULT 0,
    docs_updated INTEGER NOT NULL DEFAULT 0,
    docs_unchanged INTEGER NOT NULL DEFAULT 0,
    docs_duplicate INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
);

-- 取得ログ（エビデンス）
CREATE TABLE IF NOT EXISTS fetch_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_key TEXT,
    source_id INTEGER,
    url TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    http_status INTEGER,
    robots_decision TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    content_sha256 TEXT,
    user_agent TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE SET NULL
);

-- 正本（原文）
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER,
    url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    url_sha256 TEXT NOT NULL UNIQUE,        -- 重複登録防止キー
    title TEXT NOT NULL DEFAULT '',
    published_at TEXT,                      -- 公開日（判定できた場合）
    published_at_raw TEXT NOT NULL DEFAULT '',
    published_at_source TEXT NOT NULL DEFAULT '',  -- feed | meta | text | unknown
    first_seen_at TEXT NOT NULL,            -- 初回取得日時
    last_seen_at TEXT NOT NULL,             -- 最終取得日時
    last_changed_at TEXT,                   -- 本文が最後に変化した日時
    content_sha256 TEXT NOT NULL DEFAULT '',
    simhash TEXT NOT NULL DEFAULT '',
    text_len INTEGER NOT NULL DEFAULT 0,
    raw_html BLOB,                          -- 原文HTML（zlib圧縮）
    raw_text TEXT NOT NULL DEFAULT '',      -- 原文テキスト
    http_status INTEGER,
    http_etag TEXT,
    http_last_modified TEXT,
    lang TEXT NOT NULL DEFAULT 'ja',
    evidence_ok INTEGER NOT NULL DEFAULT 0,
    evidence_note TEXT NOT NULL DEFAULT '',
    primary_source_status TEXT NOT NULL DEFAULT 'unknown',  -- primary | secondary_linked | primary_unverified
    primary_source_url TEXT NOT NULL DEFAULT '',
    duplicate_of INTEGER,
    current_version INTEGER NOT NULL DEFAULT 1,
    priority_score INTEGER NOT NULL DEFAULT 0,
    review_status TEXT NOT NULL DEFAULT 'new',   -- new | keep | reject | pending
    review_note TEXT NOT NULL DEFAULT '',
    review_actor TEXT NOT NULL DEFAULT '',
    review_at TEXT,
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);
CREATE INDEX IF NOT EXISTS idx_documents_first_seen ON documents(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_changed ON documents(last_changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_score ON documents(priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_documents_review ON documents(review_status);

-- 差分履歴（版）
CREATE TABLE IF NOT EXISTS document_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    version_no INTEGER NOT NULL,
    captured_at TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    raw_text TEXT NOT NULL DEFAULT '',
    diff_unified TEXT NOT NULL DEFAULT '',
    added_lines INTEGER NOT NULL DEFAULT 0,
    removed_lines INTEGER NOT NULL DEFAULT 0,
    change_kinds TEXT NOT NULL DEFAULT '[]',
    fetch_log_id INTEGER,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_doc_no
    ON document_versions(document_id, version_no);

-- ルールベース分類（決定論的・再現可能）
CREATE TABLE IF NOT EXISTS classifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    version_no INTEGER NOT NULL,
    engine TEXT NOT NULL DEFAULT 'rule',
    engine_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    categories TEXT NOT NULL DEFAULT '[]',
    makers TEXT NOT NULL DEFAULT '[]',
    products TEXT NOT NULL DEFAULT '[]',
    regions TEXT NOT NULL DEFAULT '[]',
    matched_terms TEXT NOT NULL DEFAULT '{}',
    priority_score INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_class_doc_ver
    ON classifications(document_id, version_no, engine_version);

-- AI要約（派生データ・事実として扱わない）
CREATE TABLE IF NOT EXISTS ai_annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    version_no INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    is_derived INTEGER NOT NULL DEFAULT 1,   -- 常に1。正本ではないことの明示。
    model TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    request_sha256 TEXT NOT NULL DEFAULT '',
    input_chars INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    key_points TEXT NOT NULL DEFAULT '[]',
    suggested_categories TEXT NOT NULL DEFAULT '[]',
    uncertainty_notes TEXT NOT NULL DEFAULT '',
    insufficient_evidence INTEGER NOT NULL DEFAULT 0,
    grounding_status TEXT NOT NULL DEFAULT 'unverified',  -- verified | failed | unverified
    grounding_failed TEXT NOT NULL DEFAULT '[]',
    stop_reason TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    review_status TEXT NOT NULL DEFAULT 'unreviewed',
    review_actor TEXT NOT NULL DEFAULT '',
    review_at TEXT,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_doc ON ai_annotations(document_id, version_no);

-- 監査ログ
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at DESC);
"""


class Database:
    """SQLite ラッパ。スレッドごとに接続を持つ（UIとスケジューラが並行するため）。"""

    def __init__(self, path: str = DB_PATH):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._local = threading.local()
        self._write_lock = threading.RLock()
        self.init_schema()

    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=15000")
            self._local.conn = conn
        return conn

    def init_schema(self) -> None:
        with self._write_lock:
            self.conn().executescript(SCHEMA_SQL)
            cur = self.conn().execute("SELECT value FROM meta WHERE key='schema_version'")
            row = cur.fetchone()
            if row is None:
                self.conn().execute(
                    "INSERT INTO meta(key, value) VALUES('schema_version', ?)",
                    (str(SCHEMA_VERSION),),
                )
            for key, value in DEFAULT_SETTINGS.items():
                self.conn().execute(
                    "INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES(?,?,?)",
                    (key, value, now_iso()),
                )

    def query(self, sql: str, params: tuple | list = ()) -> list[sqlite3.Row]:
        return list(self.conn().execute(sql, params).fetchall())

    def one(self, sql: str, params: tuple | list = ()) -> sqlite3.Row | None:
        return self.conn().execute(sql, params).fetchone()

    def execute(self, sql: str, params: tuple | list = ()) -> sqlite3.Cursor:
        with self._write_lock:
            return self.conn().execute(sql, params)

    # -- settings ----------------------------------------------------------
    def settings(self) -> dict[str, str]:
        values = dict(DEFAULT_SETTINGS)
        for row in self.query("SELECT key, value FROM settings"):
            values[row["key"]] = row["value"]
        return values

    def setting(self, key: str, default: str = "") -> str:
        row = self.one("SELECT value FROM settings WHERE key=?", (key,))
        if row is None:
            return DEFAULT_SETTINGS.get(key, default)
        return row["value"]

    def set_setting(self, key: str, value: str) -> None:
        self.execute(
            "INSERT INTO settings(key, value, updated_at) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, now_iso()),
        )

    def setting_int(self, key: str, default: int) -> int:
        try:
            return int(str(self.setting(key, str(default))).strip())
        except (TypeError, ValueError):
            return default

    def setting_bool(self, key: str, default: bool = False) -> bool:
        return str(self.setting(key, "1" if default else "0")).strip() in ("1", "true", "True", "on")

    # -- audit -------------------------------------------------------------
    def audit(self, action: str, target_type: str = "", target_id: str = "",
              detail: str = "", actor: str | None = None) -> None:
        if actor is None:
            actor = self.setting("operator") or "system"
        self.execute(
            "INSERT INTO audit_logs(at, actor, action, target_type, target_id, detail) "
            "VALUES(?,?,?,?,?,?)",
            (now_iso(), actor, action, target_type, str(target_id), detail[:4000]),
        )

# ===========================================================================
# HTTP 取得層
#   - robots.txt を必ず確認し、Disallow なら取得しない
#   - Crawl-delay と設定値の大きい方を同一ホストの最小間隔として守る
#   - 401/403 は「会員限定/認証が必要」とみなし、再試行も回避も一切行わない
# ===========================================================================


class FetchResult:
    __slots__ = ("url", "final_url", "status", "headers", "body", "error",
                 "robots_decision", "started_at", "finished_at", "not_modified")

    def __init__(self, url: str):
        self.url = url
        self.final_url = url
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self.body: bytes = b""
        self.error: str = ""
        self.robots_decision: str = ""
        self.started_at: str = now_iso()
        self.finished_at: str = ""
        self.not_modified: bool = False

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300 and not self.error


class RobotsCache:
    """robots.txt の取得・解釈をホスト単位でキャッシュする。"""

    def __init__(self, user_agent: str):
        self.user_agent = user_agent
        self._cache: dict[str, tuple[float, urllib.robotparser.RobotFileParser | None, str]] = {}
        self._lock = threading.RLock()

    def _load(self, scheme: str, host: str):
        robots_url = f"{scheme}://{host}/robots.txt"
        parser = urllib.robotparser.RobotFileParser()
        parser.set_url(robots_url)
        request = urllib.request.Request(
            robots_url, headers={"User-Agent": self.user_agent, "Accept": "text/plain,*/*"}
        )
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SEC) as response:
                raw = response.read(512 * 1024)
            text = raw.decode("utf-8", "replace")
            parser.parse(text.splitlines())
            return parser, f"robots.txt 取得成功 ({robots_url})"
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                # robots.txt 自体が保護されている場合は「全面禁止」と解釈する（保守的運用）
                parser.disallow_all = True
                return parser, f"robots.txt が {exc.code} のため全面禁止として扱います"
            # 404 等は「制限なし」と解釈するのが慣例
            parser.allow_all = True
            return parser, f"robots.txt なし (HTTP {exc.code}) のため制限なしとして扱います"
        except Exception as exc:  # noqa: BLE001 - ネットワーク例外は全て握る
            return None, f"robots.txt を取得できませんでした: {exc}"

    def get(self, url: str):
        parts = urllib.parse.urlsplit(url)
        scheme = parts.scheme or "https"
        host = (parts.netloc or "").lower()
        if not host:
            return None, "URLが不正です"
        key = f"{scheme}://{host}"
        with self._lock:
            cached = self._cache.get(key)
            if cached and (time.time() - cached[0]) < ROBOTS_CACHE_SEC:
                return cached[1], cached[2]
            parser, note = self._load(scheme, host)
            self._cache[key] = (time.time(), parser, note)
            return parser, note

    def can_fetch(self, url: str) -> tuple[bool, str]:
        parser, note = self.get(url)
        if parser is None:
            # robots.txt が取得できないホストへはアクセスしない（保守的運用）
            return False, f"blocked: {note}"
        try:
            allowed = parser.can_fetch(self.user_agent, url)
        except Exception:  # noqa: BLE001
            return False, "blocked: robots.txt の解釈に失敗しました"
        if not allowed:
            return False, f"blocked: robots.txt により禁止されています ({note})"
        return True, f"allowed: {note}"

    def crawl_delay(self, url: str) -> float:
        parser, _ = self.get(url)
        if parser is None:
            return 0.0
        try:
            delay = parser.crawl_delay(self.user_agent)
        except Exception:  # noqa: BLE001
            return 0.0
        try:
            return float(delay) if delay else 0.0
        except (TypeError, ValueError):
            return 0.0


class RateLimiter:
    """ホストごとに最小アクセス間隔を強制する。"""

    def __init__(self, default_interval: float = 5.0):
        self.default_interval = default_interval
        self._last: dict[str, float] = {}
        self._lock = threading.RLock()

    def wait(self, url: str, interval: float | None = None) -> float:
        host = host_of(url)
        gap = float(interval if interval is not None else self.default_interval)
        gap = max(gap, 1.0)
        with self._lock:
            last = self._last.get(host, 0.0)
            wait_for = max(0.0, (last + gap) - time.monotonic())
            if wait_for > 0:
                time.sleep(min(wait_for, 60.0))
            self._last[host] = time.monotonic()
        return wait_for


class Fetcher:
    """robots.txt とレート制限を尊重する HTTP GET。リダイレクトは3回まで。"""

    def __init__(self, db: Database):
        self.db = db
        contact = ascii_header_value(db.setting("contact"), DEFAULT_CONTACT)
        self.user_agent = ascii_header_value(
            DEFAULT_USER_AGENT.format(ver=APP_VERSION, contact=contact),
            f"KankiIntelDesk/{APP_VERSION}", limit=200,
        )
        self.robots = RobotsCache(self.user_agent)
        self.limiter = RateLimiter(float(db.setting_int("min_interval_sec", 5)))
        self.respect_robots = db.setting_bool("respect_robots", True)
        self._blocked_hosts: set[str] = set()

    def fetch(self, url: str, *, etag: str | None = None,
              last_modified: str | None = None,
              interval: float | None = None) -> FetchResult:
        result = FetchResult(url)

        denied = is_denied_source(url)
        if denied:
            result.error = f"policy: {denied}"
            result.robots_decision = "denied-by-policy"
            result.finished_at = now_iso()
            return result

        host = host_of(url)
        if host in self._blocked_hosts:
            result.error = "policy: このホストは本実行内で停止済みです（429/503 または認証要求）"
            result.robots_decision = "halted"
            result.finished_at = now_iso()
            return result

        if self.respect_robots:
            allowed, decision = self.robots.can_fetch(url)
            result.robots_decision = decision
            if not allowed:
                result.error = decision
                result.finished_at = now_iso()
                return result
            crawl_delay = self.robots.crawl_delay(url)
        else:
            result.robots_decision = "skipped: robots.txt の尊重が無効化されています（非推奨）"
            crawl_delay = 0.0

        effective_interval = max(float(interval or self.limiter.default_interval), crawl_delay)
        self.limiter.wait(url, effective_interval)

        headers = {
            "User-Agent": self.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ja,en;q=0.8",
            "Accept-Encoding": "gzip",
        }
        safe_etag = ascii_header_value(etag or "", limit=200)
        if safe_etag:
            headers["If-None-Match"] = safe_etag
        safe_modified = ascii_header_value(last_modified or "", limit=200)
        if safe_modified:
            headers["If-Modified-Since"] = safe_modified

        current = url
        try:
            for _ in range(4):
                request = urllib.request.Request(current, headers=headers, method="GET")
                opener = urllib.request.build_opener(_NoRedirect())
                try:
                    response = opener.open(request, timeout=HTTP_TIMEOUT_SEC)
                except urllib.error.HTTPError as exc:
                    response = exc
                status = getattr(response, "status", None) or response.getcode()
                result.status = status
                result.headers = {k.lower(): v for k, v in response.headers.items()}

                if status in (301, 302, 303, 307, 308):
                    location = response.headers.get("Location")
                    response.close()
                    if not location:
                        result.error = f"HTTP {status} だが Location ヘッダがありません"
                        break
                    current = urllib.parse.urljoin(current, location)
                    if self.respect_robots:
                        allowed, decision = self.robots.can_fetch(current)
                        result.robots_decision = decision
                        if not allowed:
                            result.error = decision
                            break
                    self.limiter.wait(current, effective_interval)
                    continue

                if status == 304:
                    result.not_modified = True
                    response.close()
                    break

                if status in (401, 403):
                    # 会員限定情報・認証回避は行わない。恒久的に停止する。
                    result.error = (
                        f"HTTP {status}: 認証または権限が必要です。"
                        "会員限定情報の取得と認証回避は行いません。"
                    )
                    self._blocked_hosts.add(host_of(current))
                    response.close()
                    break

                if status == 429 or status >= 500:
                    retry_after = result.headers.get("retry-after", "")
                    result.error = f"HTTP {status}（Retry-After: {retry_after or '未指定'}）"
                    self._blocked_hosts.add(host_of(current))
                    response.close()
                    break

                if status >= 400:
                    result.error = f"HTTP {status}"
                    response.close()
                    break

                raw = response.read(MAX_FETCH_BYTES + 1)
                response.close()
                if len(raw) > MAX_FETCH_BYTES:
                    result.error = f"応答が上限 {MAX_FETCH_BYTES} バイトを超えました"
                    raw = raw[:MAX_FETCH_BYTES]
                if result.headers.get("content-encoding", "").lower() == "gzip":
                    try:
                        raw = gzip.decompress(raw)
                    except OSError:
                        pass
                result.body = raw
                result.final_url = current
                break
        except Exception as exc:  # noqa: BLE001
            result.error = f"{type(exc).__name__}: {exc}"

        result.finished_at = now_iso()
        return result


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """リダイレクトを自分で処理する（robots.txt を都度再確認するため）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def decode_body(body: bytes, content_type: str) -> str:
    """文字コードを推定して本文をデコードする（日本語サイト向けに cp932/euc-jp も試す）。"""
    if not body:
        return ""
    charset = ""
    match = re.search(r"charset=([\w\-]+)", content_type or "", re.I)
    if match:
        charset = match.group(1).lower()
    if not charset:
        head = body[:4096].decode("ascii", "ignore")
        meta = re.search(r'charset=["\']?([\w\-]+)', head, re.I)
        if meta:
            charset = meta.group(1).lower()
    candidates = []
    if charset:
        candidates.append({"shift_jis": "cp932", "shift-jis": "cp932", "sjis": "cp932",
                           "x-sjis": "cp932"}.get(charset, charset))
    candidates += ["utf-8", "cp932", "euc_jp", "iso2022_jp"]
    for enc in candidates:
        try:
            return body.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return body.decode("utf-8", "replace")

# ===========================================================================
# パーサ（HTML / RSS / Atom / 日付）
# ===========================================================================


class HtmlDocument:
    __slots__ = ("title", "text", "links", "meta", "published_at", "published_raw",
                 "published_source")

    def __init__(self):
        self.title = ""
        self.text = ""
        self.links: list[tuple[str, str]] = []
        self.meta: dict[str, str] = {}
        self.published_at: dt.datetime | None = None
        self.published_raw = ""
        self.published_source = "unknown"


class _HtmlTextParser(HTMLParser):
    SKIP_TAGS = {"script", "style", "noscript", "svg", "head", "iframe", "template", "object"}
    BLOCK_TAGS = {"p", "div", "br", "li", "tr", "td", "th", "section", "article", "header",
                  "footer", "nav", "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd", "table",
                  "ul", "ol", "blockquote", "figure", "hr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.links: list[tuple[str, str]] = []
        self.meta: dict[str, str] = {}
        self.title_parts: list[str] = []
        self._skip_depth = 0
        self._in_title = False
        self._a_href: str | None = None
        self._a_text: list[str] = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        attributes = {k.lower(): (v or "") for k, v in attrs}
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
            if tag != "head":
                return
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            name = (attributes.get("property") or attributes.get("name") or "").lower()
            if name:
                self.meta[name] = attributes.get("content", "")
            if attributes.get("itemprop", "").lower() in ("datepublished", "datemodified"):
                self.meta[attributes["itemprop"].lower()] = attributes.get("content", "")
        elif tag == "time":
            if attributes.get("datetime"):
                self.meta.setdefault("__time_datetime", attributes["datetime"])
        elif tag == "a":
            self._a_href = attributes.get("href")
            self._a_text = []
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False
        if tag == "a" and self._a_href is not None:
            self.links.append((self._a_href, "".join(self._a_text).strip()))
            self._a_href = None
            self._a_text = []
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title_parts.append(data)
            return
        if self._skip_depth > 0:
            return
        self.parts.append(data)
        if self._a_href is not None:
            self._a_text.append(data)

    def error(self, message):  # HTMLParser 互換用（Python 3.9 以前）
        pass


JP_DATE_RE = re.compile(
    r"(?P<y>19\d{2}|20\d{2})\s*[年/\-\.]\s*(?P<m>1[0-2]|0?[1-9])\s*[月/\-\.]\s*(?P<d>3[01]|[12]\d|0?[1-9])"
)
REIWA_RE = re.compile(r"令和\s*(?P<y>元|\d{1,2})\s*年\s*(?P<m>\d{1,2})\s*月\s*(?P<d>\d{1,2})\s*日")


def parse_datetime_any(value: str | None) -> tuple[dt.datetime | None, str]:
    """様々な日付表記を UTC の datetime に正規化する。判定できなければ (None, '')。"""
    if not value:
        return None, ""
    text = str(value).strip()
    if not text:
        return None, ""

    # ISO 8601
    candidate = text.replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(candidate)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=JST)
        return parsed.astimezone(dt.timezone.utc), text
    except ValueError:
        pass

    # RFC 822 (RSS pubDate)
    try:
        parsed = parsedate_to_datetime(text)
        if parsed is not None:
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=JST)
            return parsed.astimezone(dt.timezone.utc), text
    except (TypeError, ValueError, IndexError):
        pass

    # 令和表記
    match = REIWA_RE.search(text)
    if match:
        year_part = match.group("y")
        year = 2018 + (1 if year_part == "元" else int(year_part))
        try:
            parsed = dt.datetime(year, int(match.group("m")), int(match.group("d")), tzinfo=JST)
            return parsed.astimezone(dt.timezone.utc), match.group(0)
        except ValueError:
            pass

    # 2026年8月4日 / 2026/08/04 / 2026-08-04 / 2026.8.4
    match = JP_DATE_RE.search(text)
    if match:
        try:
            parsed = dt.datetime(int(match.group("y")), int(match.group("m")),
                                 int(match.group("d")), tzinfo=JST)
            return parsed.astimezone(dt.timezone.utc), match.group(0)
        except ValueError:
            pass
    return None, ""


META_DATE_KEYS = [
    "article:published_time", "article:modified_time", "og:published_time",
    "datepublished", "datemodified", "pubdate", "date", "dcterms.created",
    "dc.date", "dc.date.issued", "publish-date", "__time_datetime",
]


def parse_html(html_text: str, base_url: str) -> HtmlDocument:
    doc = HtmlDocument()
    parser = _HtmlTextParser()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:  # noqa: BLE001 - 壊れたHTMLでも取れた分を使う
        pass

    doc.meta = parser.meta
    title = "".join(parser.title_parts).strip()
    doc.title = normalize_text(
        parser.meta.get("og:title") or parser.meta.get("twitter:title") or title
    )[:500]

    raw_text = "".join(parser.parts)
    doc.text = normalize_text(raw_text)[:MAX_STORED_TEXT_CHARS]

    for href, label in parser.links:
        if not href:
            continue
        href = href.strip()
        if href.startswith(("javascript:", "mailto:", "tel:", "#")):
            continue
        try:
            absolute = urllib.parse.urljoin(base_url, href)
        except ValueError:
            continue
        if absolute.startswith(("http://", "https://")):
            doc.links.append((absolute, normalize_text(label)[:300]))

    for key in META_DATE_KEYS:
        if key in parser.meta and parser.meta[key]:
            parsed, raw = parse_datetime_any(parser.meta[key])
            if parsed:
                doc.published_at = parsed
                doc.published_raw = raw
                doc.published_source = "meta"
                break

    if doc.published_at is None:
        head = doc.text[:1500]
        parsed, raw = parse_datetime_any(head)
        if parsed:
            doc.published_at = parsed
            doc.published_raw = raw
            doc.published_source = "text"
    return doc


def _xml_localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower() if "}" in tag else tag.lower()


def _xml_find(element, *names) -> str:
    for child in element:
        if _xml_localname(child.tag) in names:
            if child.text and child.text.strip():
                return child.text.strip()
    return ""


def parse_feed(xml_text: str, base_url: str) -> list[dict]:
    """RSS 2.0 / RDF / Atom を共通形式のリストに変換する。"""
    items: list[dict] = []
    try:
        root = ElementTree.fromstring(xml_text.encode("utf-8", "replace"))
    except ElementTree.ParseError:
        return items

    nodes = []
    for element in root.iter():
        if _xml_localname(element.tag) in ("item", "entry"):
            nodes.append(element)

    for node in nodes:
        title = _xml_find(node, "title")
        link = ""
        for child in node:
            if _xml_localname(child.tag) == "link":
                href = child.attrib.get("href")
                rel = (child.attrib.get("rel") or "alternate").lower()
                if href and rel == "alternate":
                    link = href
                    break
                if child.text and child.text.strip():
                    link = child.text.strip()
        if not link:
            link = _xml_find(node, "guid", "id")
        if not link:
            continue
        try:
            link = urllib.parse.urljoin(base_url, link)
        except ValueError:
            continue
        if not link.startswith(("http://", "https://")):
            continue

        date_raw = _xml_find(node, "pubdate", "published", "updated", "date", "modified")
        published, raw = parse_datetime_any(date_raw)
        summary_html = _xml_find(node, "description", "summary", "content", "encoded")
        summary_text = normalize_text(re.sub(r"<[^>]+>", " ", summary_html)) if summary_html else ""

        items.append({
            "title": normalize_text(title)[:500],
            "url": link,
            "published_at": published,
            "published_raw": raw or date_raw,
            "summary": summary_text[:20000],
        })
    return items


def looks_like_feed(body: bytes, content_type: str) -> bool:
    ctype = (content_type or "").lower()
    if any(token in ctype for token in ("rss", "atom", "xml")):
        head = body[:2048].decode("utf-8", "ignore").lower()
        return "<rss" in head or "<feed" in head or "<rdf" in head or "<?xml" in head
    head = body[:2048].decode("utf-8", "ignore").lower()
    return "<rss" in head or "<feed" in head or ("<?xml" in head and "<rdf" in head)

# ===========================================================================
# ルールベース分類エンジン
#   AIは使わない。完全に決定論的で、同じ入力からは常に同じ結果が出る。
#   engine_version と一緒に保存するため、後から根拠を再現できる。
# ===========================================================================


class Classification:
    __slots__ = ("domain", "categories", "makers", "products", "regions",
                 "matched_terms", "priority_score")

    def __init__(self):
        self.domain = ""
        self.categories: list[str] = []
        self.makers: list[str] = []
        self.products: list[str] = []
        self.regions: list[str] = []
        self.matched_terms: dict[str, list[str]] = {}
        self.priority_score = 0

    def to_row(self) -> dict:
        return {
            "domain": self.domain,
            "categories": json.dumps(self.categories, ensure_ascii=False),
            "makers": json.dumps(self.makers, ensure_ascii=False),
            "products": json.dumps(self.products, ensure_ascii=False),
            "regions": json.dumps(self.regions, ensure_ascii=False),
            "matched_terms": json.dumps(self.matched_terms, ensure_ascii=False),
            "priority_score": self.priority_score,
        }


def _match_group(haystack: str, table: dict[str, list[str]]) -> tuple[list[str], dict[str, list[str]]]:
    hits: list[str] = []
    matched: dict[str, list[str]] = {}
    for label, terms in table.items():
        found = [term for term in terms if term and term.lower() in haystack]
        if found:
            hits.append(label)
            matched[label] = found[:6]
    return hits, matched


def classify(title: str, text: str, *, source_tier: int = 1,
             source_region: str = "", source_maker: str = "",
             published_at: dt.datetime | None = None,
             priority_regions: list[str] | None = None) -> Classification:
    result = Classification()
    priority_regions = priority_regions or PRIORITY_REGIONS

    # タイトルは本文より重要なので2回分の重みで探索対象に入れる
    haystack = normalize_text(f"{title}\n{title}\n{text}").lower()

    project_hits, project_terms = _match_group(haystack, PROJECT_CATEGORIES)
    maker_cat_hits, maker_cat_terms = _match_group(haystack, MAKER_CATEGORIES)
    maker_hits, maker_terms = _match_group(haystack, WATCH_MAKERS)
    product_hits, product_terms = _match_group(haystack, PRODUCT_TERMS)
    region_hits, region_terms = _match_group(haystack, REGION_TERMS)

    if source_maker and source_maker not in maker_hits:
        # 情報源として登録済みのメーカー公式サイトは、本文に社名が無くても紐づける
        maker_hits.insert(0, source_maker)
        maker_terms.setdefault(source_maker, ["情報源登録による紐付け"])

    result.categories = project_hits + maker_cat_hits
    result.makers = maker_hits
    result.products = product_hits
    result.regions = region_hits or ([source_region] if source_region else [])

    if not result.regions:
        for term in NATIONWIDE_TERMS:
            if term.lower() in haystack:
                result.regions = ["全国"]
                break

    if maker_hits or product_hits or maker_cat_hits:
        result.domain = "maker" if not project_hits else "both"
    elif project_hits:
        result.domain = "construction"
    else:
        result.domain = "other"

    result.matched_terms = {
        "project": project_terms,
        "maker_category": maker_cat_terms,
        "maker": maker_terms,
        "product": product_terms,
        "region": region_terms,
    }

    # --- 優先度スコア（0-100） -------------------------------------------
    # 加点の合計上限は約94。上限に張り付いて順位が付かなくならないよう配分している。
    score = 0
    score += {1: 22, 2: 20, 3: 16, 4: 12, 5: 13, 6: 9}.get(int(source_tier or 1), 8)
    if maker_hits:
        score += 18
    if product_hits:
        score += 10
    if any(region in priority_regions for region in result.regions):
        score += 8
    elif "全国" in result.regions:
        score += 4
    # 重要カテゴリは「1つでも該当」ではなく該当数で差をつける（最大24点）
    high_value_hits = sum(1 for c in result.categories if c in HIGH_VALUE_CATEGORIES)
    score += min(24, high_value_hits * 8)
    if result.categories and high_value_hits == 0:
        score += 4
    if published_at:
        age_days = (now_utc() - published_at).total_seconds() / 86400.0
        if age_days <= 3:
            score += 8
        elif age_days <= 14:
            score += 4
    if not result.categories and not maker_hits and not product_hits:
        score = min(score, 20)
    result.priority_score = max(0, min(100, score))
    return result


def detect_change_kinds(diff_text: str) -> list[str]:
    """差分の追加行から、業務上重要な変化の種類を検出する。"""
    added = "\n".join(
        line[1:] for line in diff_text.splitlines()
        if line.startswith("+") and not line.startswith("+++")
    )
    if not added:
        return []
    lowered = normalize_text(added).lower()
    kinds = [term for term in CHANGE_SIGNAL_TERMS if term.lower() in lowered]
    return kinds[:20]


def evaluate_evidence(url: str, raw_text: str, source_tier: int,
                      links: list[tuple[str, str]] | None = None) -> tuple[bool, str, str, str]:
    """
    エビデンス充足性と一次情報の状態を判定する。
    戻り値: (evidence_ok, evidence_note, primary_source_status, primary_source_url)
    """
    notes: list[str] = []
    denied = is_denied_source(url)
    if denied:
        return False, denied, "unknown", ""
    if not url.startswith(("http://", "https://")):
        return False, "情報元URLが不正です", "unknown", ""
    if len(normalize_text(raw_text)) < 20:
        notes.append("原文テキストが極端に短いため内容確認が必要です")

    tier = int(source_tier or 1)
    primary_url = ""
    if tier <= 3:
        status = "primary"
    else:
        # 二次情報の場合、本文中に一次情報らしきリンクがあるか探索する（要件 4 後段）
        for href, _label in (links or []):
            host = host_of(href)
            if host and host != host_of(url) and host.endswith(PRIMARY_HINT_TLDS):
                primary_url = href
                break
        if primary_url:
            status = "secondary_linked"
            notes.append(f"一次情報候補リンクを検出: {primary_url}")
        else:
            status = "primary_unverified"
            notes.append("一次情報未確認（発表元の一次情報を確認してください）")

    evidence_ok = True
    return evidence_ok, " / ".join(notes), status, primary_url


PRIMARY_STATUS_LABEL = {
    "primary": "一次情報",
    "secondary_linked": "二次情報（一次リンクあり）",
    "primary_unverified": "一次情報未確認",
    "unknown": "判定不能",
}

# ===========================================================================
# 収集パイプライン
# ===========================================================================


class CollectStats:
    def __init__(self):
        self.sources_total = 0
        self.sources_ok = 0
        self.sources_skipped = 0
        self.sources_error = 0
        self.docs_new = 0
        self.docs_updated = 0
        self.docs_unchanged = 0
        self.docs_duplicate = 0
        self.messages: list[str] = []

    def as_dict(self) -> dict:
        return {
            "sources_total": self.sources_total,
            "sources_ok": self.sources_ok,
            "sources_skipped": self.sources_skipped,
            "sources_error": self.sources_error,
            "docs_new": self.docs_new,
            "docs_updated": self.docs_updated,
            "docs_unchanged": self.docs_unchanged,
            "docs_duplicate": self.docs_duplicate,
            "messages": self.messages[-200:],
        }


class Collector:
    def __init__(self, db: Database):
        self.db = db
        self.fetcher = Fetcher(db)
        self.priority_regions = [
            r.strip() for r in db.setting("priority_regions").split(",") if r.strip()
        ]
        self._cancel = threading.Event()

    def cancel(self) -> None:
        self._cancel.set()

    # -- ログ ---------------------------------------------------------------
    def _log_fetch(self, run_key: str, source_id: int | None, result: FetchResult) -> int:
        cur = self.db.execute(
            "INSERT INTO fetch_logs(run_key, source_id, url, started_at, finished_at, "
            "http_status, robots_decision, bytes, content_sha256, user_agent, error) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (run_key, source_id, result.url, result.started_at, result.finished_at,
             result.status, result.robots_decision[:500], len(result.body),
             sha256_bytes(result.body) if result.body else None,
             self.fetcher.user_agent, result.error[:1000]),
        )
        return int(cur.lastrowid)

    # -- 文書の保存 ---------------------------------------------------------
    def store_document(self, *, source: sqlite3.Row | None, url: str, title: str,
                       raw_text: str, raw_html: bytes | None,
                       published_at: dt.datetime | None, published_raw: str,
                       published_source: str, http_status: int | None,
                       etag: str | None, last_modified: str | None,
                       links: list[tuple[str, str]] | None,
                       fetch_log_id: int | None, stats: CollectStats) -> tuple[int, str]:
        """
        原文を正本として保存する。既存文書なら差分を版として追加する。
        戻り値: (document_id, 'new' | 'updated' | 'unchanged' | 'duplicate' | 'rejected')
        """
        canonical = canonicalize_url(url)
        url_key = sha256_text(canonical)
        normalized_text = normalize_text(raw_text)[:MAX_STORED_TEXT_CHARS]
        content_hash = sha256_text(f"{normalize_text(title)}\n{normalized_text}")
        source_id = int(source["id"]) if source is not None else None
        source_tier = int(source["tier"]) if source is not None else 6
        source_maker = (source["maker"] or "") if source is not None else ""
        source_region = (source["region"] or "") if source is not None else ""
        timestamp = now_iso()

        evidence_ok, evidence_note, primary_status, primary_url = evaluate_evidence(
            canonical, normalized_text, source_tier, links
        )
        if not evidence_ok:
            # 要件: エビデンスを追跡できない情報は採用しない
            stats.messages.append(f"不採用（エビデンス不足）: {canonical} / {evidence_note}")
            self.db.audit("document.rejected", "url", canonical, evidence_note)
            return 0, "rejected"

        existing = self.db.one("SELECT * FROM documents WHERE url_sha256=?", (url_key,))

        if existing is None:
            simhash = simhash64(normalized_text or title)
            near = None
            if len(normalized_text) >= 200:
                candidates = self.db.query(
                    "SELECT id, simhash, canonical_url FROM documents "
                    "WHERE simhash != '' AND first_seen_at >= ? LIMIT 800",
                    (iso(now_utc() - dt.timedelta(days=45)),),
                )
                for row in candidates:
                    if hamming_hex(simhash, row["simhash"]) <= NEAR_DUPLICATE_MAX_DISTANCE:
                        near = row
                        break

            classification = classify(
                title, normalized_text, source_tier=source_tier,
                source_region=source_region, source_maker=source_maker,
                published_at=published_at, priority_regions=self.priority_regions,
            )

            cur = self.db.execute(
                "INSERT INTO documents(source_id, url, canonical_url, url_sha256, title, "
                "published_at, published_at_raw, published_at_source, first_seen_at, last_seen_at, "
                "last_changed_at, content_sha256, simhash, text_len, raw_html, raw_text, "
                "http_status, http_etag, http_last_modified, lang, evidence_ok, evidence_note, "
                "primary_source_status, primary_source_url, duplicate_of, current_version, "
                "priority_score) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (source_id, url, canonical, url_key, normalize_text(title)[:500],
                 iso(published_at), published_raw[:200], published_source,
                 timestamp, timestamp, timestamp, content_hash, simhash,
                 len(normalized_text), compress(raw_html), normalized_text,
                 http_status, etag, last_modified, "ja", 1, evidence_note[:1000],
                 primary_status, primary_url[:500],
                 int(near["id"]) if near else None, 1, classification.priority_score),
            )
            document_id = int(cur.lastrowid)

            self.db.execute(
                "INSERT INTO document_versions(document_id, version_no, captured_at, "
                "content_sha256, title, raw_text, diff_unified, added_lines, removed_lines, "
                "change_kinds, fetch_log_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (document_id, 1, timestamp, content_hash, normalize_text(title)[:500],
                 normalized_text, "", len(normalized_text.splitlines()), 0,
                 json.dumps(["初回取得"], ensure_ascii=False), fetch_log_id),
            )
            self._save_classification(document_id, 1, classification)

            if near:
                stats.docs_duplicate += 1
                self.db.audit("document.near_duplicate", "document", document_id,
                              f"近似重複候補: {near['canonical_url']}")
            stats.docs_new += 1
            return document_id, "new"

        document_id = int(existing["id"])
        if existing["content_sha256"] == content_hash:
            self.db.execute(
                "UPDATE documents SET last_seen_at=?, http_status=?, http_etag=?, "
                "http_last_modified=? WHERE id=?",
                (timestamp, http_status, etag, last_modified, document_id),
            )
            stats.docs_unchanged += 1
            return document_id, "unchanged"

        # --- 本文が変化した: 差分を新しい版として保存 -----------------------
        previous_text = existing["raw_text"] or ""
        diff_lines = list(difflib.unified_diff(
            previous_text.splitlines(),
            normalized_text.splitlines(),
            fromfile=f"v{existing['current_version']}",
            tofile=f"v{int(existing['current_version']) + 1}",
            lineterm="", n=2,
        ))
        diff_text = "\n".join(diff_lines)[:200_000]
        added = sum(1 for line in diff_lines if line.startswith("+") and not line.startswith("+++"))
        removed = sum(1 for line in diff_lines if line.startswith("-") and not line.startswith("---"))
        change_kinds = detect_change_kinds(diff_text)
        version_no = int(existing["current_version"]) + 1

        classification = classify(
            title, normalized_text, source_tier=source_tier,
            source_region=source_region, source_maker=source_maker,
            published_at=published_at, priority_regions=self.priority_regions,
        )
        if change_kinds:
            classification.priority_score = min(100, classification.priority_score + 10)

        self.db.execute(
            "INSERT INTO document_versions(document_id, version_no, captured_at, "
            "content_sha256, title, raw_text, diff_unified, added_lines, removed_lines, "
            "change_kinds, fetch_log_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (document_id, version_no, timestamp, content_hash,
             normalize_text(title)[:500], normalized_text, diff_text, added, removed,
             json.dumps(change_kinds, ensure_ascii=False), fetch_log_id),
        )
        self.db.execute(
            "UPDATE documents SET title=?, raw_text=?, raw_html=?, content_sha256=?, "
            "simhash=?, text_len=?, last_seen_at=?, last_changed_at=?, current_version=?, "
            "http_status=?, http_etag=?, http_last_modified=?, priority_score=?, "
            "published_at=COALESCE(?, published_at), evidence_note=?, "
            "primary_source_status=?, primary_source_url=?, "
            "review_status=CASE WHEN review_status='reject' THEN 'reject' ELSE 'new' END "
            "WHERE id=?",
            (normalize_text(title)[:500], normalized_text, compress(raw_html), content_hash,
             simhash64(normalized_text or title), len(normalized_text), timestamp, timestamp,
             version_no, http_status, etag, last_modified, classification.priority_score,
             iso(published_at), evidence_note[:1000], primary_status, primary_url[:500],
             document_id),
        )
        self._save_classification(document_id, version_no, classification)
        stats.docs_updated += 1
        self.db.audit("document.updated", "document", document_id,
                      f"v{version_no} 変更検出: +{added}/-{removed} {change_kinds}")
        return document_id, "updated"

    def _save_classification(self, document_id: int, version_no: int,
                             classification: Classification) -> None:
        row = classification.to_row()
        self.db.execute(
            "INSERT OR REPLACE INTO classifications(document_id, version_no, engine, "
            "engine_version, created_at, domain, categories, makers, products, regions, "
            "matched_terms, priority_score) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (document_id, version_no, "rule", CLASSIFIER_VERSION, now_iso(),
             row["domain"], row["categories"], row["makers"], row["products"],
             row["regions"], row["matched_terms"], row["priority_score"]),
        )

    # -- 情報源1件の収集 -----------------------------------------------------
    def collect_source(self, source: sqlite3.Row, run_key: str, stats: CollectStats) -> None:
        source_id = int(source["id"])
        name = source["name"]
        url = (source["url"] or "").strip()

        if not url:
            stats.sources_skipped += 1
            stats.messages.append(f"スキップ: {name} — 監視URLが未登録です")
            return
        if not int(source["url_verified"]):
            stats.sources_skipped += 1
            stats.messages.append(f"スキップ: {name} — URL未確認（管理画面で確認済みにしてください）")
            return
        if not int(source["terms_confirmed"]):
            stats.sources_skipped += 1
            stats.messages.append(f"スキップ: {name} — 利用規約が未確認です")
            return

        interval = float(source["min_interval_sec"] or self.fetcher.limiter.default_interval)
        result = self.fetcher.fetch(
            url, etag=source["http_etag"], last_modified=source["http_last_modified"],
            interval=interval,
        )
        fetch_log_id = self._log_fetch(run_key, source_id, result)

        self.db.execute(
            "UPDATE sources SET last_fetch_at=?, robots_decision=?, robots_checked_at=? WHERE id=?",
            (now_iso(), result.robots_decision[:500], now_iso(), source_id),
        )

        if result.not_modified:
            self.db.execute(
                "UPDATE sources SET last_status=?, last_error='', consecutive_errors=0 WHERE id=?",
                ("304 未更新", source_id),
            )
            stats.sources_ok += 1
            stats.messages.append(f"未更新: {name}（HTTP 304）")
            return

        if not result.ok:
            errors = int(source["consecutive_errors"]) + 1
            disable = ""
            if errors >= 5:
                self.db.execute("UPDATE sources SET enabled=0 WHERE id=?", (source_id,))
                disable = " / 連続5回失敗のため自動停止しました"
                self.db.audit("source.auto_disabled", "source", source_id, result.error[:500])
            self.db.execute(
                "UPDATE sources SET last_status=?, last_error=?, consecutive_errors=? WHERE id=?",
                (f"エラー {result.status or ''}".strip(), (result.error + disable)[:1000],
                 errors, source_id),
            )
            stats.sources_error += 1
            stats.messages.append(f"失敗: {name} — {result.error}{disable}")
            return

        content_type = result.headers.get("content-type", "")
        etag = result.headers.get("etag")
        last_modified = result.headers.get("last-modified")
        source_type = source["source_type"]
        if source_type == "auto" or not source_type:
            source_type = "rss" if looks_like_feed(result.body, content_type) else "html"

        max_pages = int(source["max_pages"] or 12)
        try:
            if source_type == "rss" or looks_like_feed(result.body, content_type):
                self._collect_feed(source, result, content_type, run_key, stats,
                                   max_pages, interval)
            elif source_type == "html_list":
                self._collect_html_list(source, result, content_type, run_key, stats,
                                        max_pages, interval, fetch_log_id)
            else:
                self._collect_html_page(source, result, content_type, stats, fetch_log_id)
        except Exception as exc:  # noqa: BLE001
            stats.sources_error += 1
            stats.messages.append(f"解析失敗: {name} — {type(exc).__name__}: {exc}")
            self.db.execute(
                "UPDATE sources SET last_status='解析エラー', last_error=? WHERE id=?",
                (f"{type(exc).__name__}: {exc}"[:1000], source_id),
            )
            return

        self.db.execute(
            "UPDATE sources SET last_status='正常', last_error='', consecutive_errors=0, "
            "http_etag=?, http_last_modified=? WHERE id=?",
            (etag, last_modified, source_id),
        )
        stats.sources_ok += 1

    def _collect_html_page(self, source: sqlite3.Row, result: FetchResult,
                           content_type: str, stats: CollectStats,
                           fetch_log_id: int | None) -> None:
        """ページそのものを1件の文書として監視する（お知らせページの差分監視向け）。"""
        html_text = decode_body(result.body, content_type)
        parsed = parse_html(html_text, result.final_url)
        title = parsed.title or source["name"]
        self.store_document(
            source=source, url=result.final_url, title=title, raw_text=parsed.text,
            raw_html=result.body, published_at=parsed.published_at,
            published_raw=parsed.published_raw, published_source=parsed.published_source,
            http_status=result.status, etag=result.headers.get("etag"),
            last_modified=result.headers.get("last-modified"), links=parsed.links,
            fetch_log_id=fetch_log_id, stats=stats,
        )

    def _collect_feed(self, source: sqlite3.Row, result: FetchResult, content_type: str,
                      run_key: str, stats: CollectStats, max_pages: int,
                      interval: float) -> None:
        xml_text = decode_body(result.body, content_type)
        entries = parse_feed(xml_text, result.final_url)
        if not entries:
            stats.messages.append(f"注意: {source['name']} — フィードから記事を抽出できませんでした")
            return
        for entry in entries[:max_pages]:
            if self._cancel.is_set():
                return
            self._fetch_and_store_article(
                source, entry["url"], run_key, stats, interval,
                fallback_title=entry["title"],
                fallback_text=entry["summary"],
                fallback_published=entry["published_at"],
                fallback_published_raw=entry["published_raw"],
            )

    def _collect_html_list(self, source: sqlite3.Row, result: FetchResult, content_type: str,
                           run_key: str, stats: CollectStats, max_pages: int,
                           interval: float, fetch_log_id: int | None) -> None:
        html_text = decode_body(result.body, content_type)
        parsed = parse_html(html_text, result.final_url)
        # 一覧ページ自体も差分監視の対象として保存する
        self.store_document(
            source=source, url=result.final_url, title=parsed.title or source["name"],
            raw_text=parsed.text, raw_html=result.body,
            published_at=parsed.published_at, published_raw=parsed.published_raw,
            published_source=parsed.published_source, http_status=result.status,
            etag=result.headers.get("etag"),
            last_modified=result.headers.get("last-modified"),
            links=parsed.links, fetch_log_id=fetch_log_id, stats=stats,
        )

        pattern = (source["link_filter"] or "").strip()
        regex = None
        if pattern:
            try:
                regex = re.compile(pattern)
            except re.error as exc:
                stats.messages.append(f"注意: {source['name']} — link_filter が不正です: {exc}")

        base_host = host_of(result.final_url)
        seen: set[str] = set()
        followed = 0
        for href, label in parsed.links:
            if followed >= max_pages or self._cancel.is_set():
                break
            if host_of(href) != base_host:
                continue
            canonical = canonicalize_url(href)
            if canonical in seen or canonical == canonicalize_url(result.final_url):
                continue
            if regex is not None:
                if not regex.search(href):
                    continue
            else:
                haystack = f"{href} {label}".lower()
                if not any(kw in haystack for kw in
                           ("news", "topics", "info", "release", "oshirase", "お知らせ",
                            "ニュース", "新着", "発表", "公告", "入札", "更新")):
                    continue
            seen.add(canonical)
            followed += 1
            self._fetch_and_store_article(source, href, run_key, stats, interval,
                                          fallback_title=label)

    def _fetch_and_store_article(self, source: sqlite3.Row, url: str, run_key: str,
                                 stats: CollectStats, interval: float, *,
                                 fallback_title: str = "",
                                 fallback_text: str = "",
                                 fallback_published: dt.datetime | None = None,
                                 fallback_published_raw: str = "") -> None:
        canonical = canonicalize_url(url)
        url_key = sha256_text(canonical)
        existing = self.db.one(
            "SELECT id, http_etag, http_last_modified, content_sha256 FROM documents "
            "WHERE url_sha256=?", (url_key,)
        )
        result = self.fetcher.fetch(
            url,
            etag=existing["http_etag"] if existing else None,
            last_modified=existing["http_last_modified"] if existing else None,
            interval=interval,
        )
        fetch_log_id = self._log_fetch(run_key, int(source["id"]), result)

        if result.not_modified and existing:
            self.db.execute("UPDATE documents SET last_seen_at=? WHERE id=?",
                            (now_iso(), int(existing["id"])))
            stats.docs_unchanged += 1
            return

        if not result.ok:
            stats.messages.append(f"記事取得失敗: {url} — {result.error}")
            return

        content_type = result.headers.get("content-type", "")
        if "html" not in content_type.lower() and "xml" not in content_type.lower() \
                and content_type:
            # PDF等はローカル解析せず、URLと取得ログのみを証跡として残す
            stats.messages.append(
                f"本文未解析（{content_type}）: {url} — URLと取得ログのみ保存しました")
            return

        html_text = decode_body(result.body, content_type)
        parsed = parse_html(html_text, result.final_url)
        title = parsed.title or fallback_title or url
        text = parsed.text or fallback_text
        published = parsed.published_at or fallback_published
        published_raw = parsed.published_raw or fallback_published_raw
        published_source = parsed.published_source if parsed.published_at else (
            "feed" if fallback_published else "unknown"
        )
        self.store_document(
            source=source, url=result.final_url, title=title, raw_text=text,
            raw_html=result.body, published_at=published, published_raw=published_raw,
            published_source=published_source, http_status=result.status,
            etag=result.headers.get("etag"),
            last_modified=result.headers.get("last-modified"),
            links=parsed.links, fetch_log_id=fetch_log_id, stats=stats,
        )

    # -- 実行 ---------------------------------------------------------------
    def run(self, *, mode: str = "manual", source_ids: list[int] | None = None) -> dict:
        run_key = f"{dt.datetime.now(JST).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        stats = CollectStats()
        self.db.execute(
            "INSERT INTO runs(run_key, mode, started_at) VALUES(?,?,?)",
            (run_key, mode, now_iso()),
        )
        self.db.audit("collect.start", "run", run_key, f"mode={mode}")

        if source_ids:
            placeholders = ",".join("?" for _ in source_ids)
            sources = self.db.query(
                f"SELECT * FROM sources WHERE id IN ({placeholders}) ORDER BY tier, id",
                source_ids,
            )
        else:
            sources = self.db.query(
                "SELECT * FROM sources WHERE enabled=1 ORDER BY tier, id"
            )
        stats.sources_total = len(sources)

        for source in sources:
            if self._cancel.is_set():
                stats.messages.append("収集が中断されました")
                break
            try:
                self.collect_source(source, run_key, stats)
            except Exception as exc:  # noqa: BLE001
                stats.sources_error += 1
                stats.messages.append(
                    f"想定外のエラー: {source['name']} — {type(exc).__name__}: {exc}")
                self.db.audit("collect.error", "source", source["id"],
                              traceback.format_exc()[:2000])

        self.db.execute(
            "UPDATE runs SET finished_at=?, sources_total=?, sources_ok=?, sources_skipped=?, "
            "sources_error=?, docs_new=?, docs_updated=?, docs_unchanged=?, docs_duplicate=?, "
            "note=? WHERE run_key=?",
            (now_iso(), stats.sources_total, stats.sources_ok, stats.sources_skipped,
             stats.sources_error, stats.docs_new, stats.docs_updated, stats.docs_unchanged,
             stats.docs_duplicate, "\n".join(stats.messages[-50:])[:8000], run_key),
        )
        self.db.audit("collect.finish", "run", run_key, json.dumps(stats.as_dict(),
                                                                   ensure_ascii=False)[:2000])
        payload = stats.as_dict()
        payload["run_key"] = run_key
        return payload


class CollectionManager:
    """UIから叩く収集の実行状態を1つに保つ（同時実行を防ぐ）。"""

    def __init__(self, db: Database):
        self.db = db
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._collector: Collector | None = None
        self.state: dict = {"running": False, "run_key": "", "started_at": "",
                            "progress": "", "last_result": None}

    @property
    def running(self) -> bool:
        return bool(self.state.get("running"))

    def start(self, *, mode: str = "manual", source_ids: list[int] | None = None) -> dict:
        with self._lock:
            if self.running:
                return {"ok": False, "error": "収集はすでに実行中です"}
            collector = Collector(self.db)
            self._collector = collector
            self.state = {"running": True, "run_key": "", "started_at": now_iso(),
                          "progress": "開始しました", "last_result": None}

            def worker() -> None:
                try:
                    result = collector.run(mode=mode, source_ids=source_ids)
                    self.state["last_result"] = result
                    self.state["run_key"] = result.get("run_key", "")
                    self.state["progress"] = "完了"
                    if self.db.setting_bool("ai_auto_on_collect"):
                        try:
                            auto_annotate(self.db)
                        except Exception as exc:  # noqa: BLE001
                            self.db.audit("ai.auto_error", "run", result.get("run_key", ""),
                                          str(exc)[:500])
                except Exception as exc:  # noqa: BLE001
                    self.state["progress"] = f"異常終了: {exc}"
                    self.db.audit("collect.fatal", "", "", traceback.format_exc()[:2000])
                finally:
                    self.state["running"] = False

            self._thread = threading.Thread(target=worker, name="collector", daemon=True)
            self._thread.start()
            return {"ok": True}

    def cancel(self) -> dict:
        if self._collector and self.running:
            self._collector.cancel()
            return {"ok": True}
        return {"ok": False, "error": "実行中の収集はありません"}


class Scheduler:
    """毎日決まった時刻に収集を実行する常駐スレッド。"""

    def __init__(self, db: Database, manager: CollectionManager):
        self.db = db
        self.manager = manager
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def next_run_at(self) -> str:
        if not self.db.setting_bool("schedule_enabled"):
            return ""
        target = self._parse_time()
        if target is None:
            return ""
        now_local = dt.datetime.now(JST)
        candidate = now_local.replace(hour=target[0], minute=target[1], second=0, microsecond=0)
        last = self.db.setting("_last_scheduled_date", "")
        if candidate <= now_local or last == candidate.strftime("%Y-%m-%d"):
            candidate += dt.timedelta(days=1)
        return candidate.isoformat(timespec="minutes")

    def _parse_time(self) -> tuple[int, int] | None:
        value = (self.db.setting("schedule_time") or "").strip()
        match = re.match(r"^(\d{1,2}):(\d{2})$", value)
        if not match:
            return None
        hour, minute = int(match.group(1)), int(match.group(2))
        if 0 <= hour < 24 and 0 <= minute < 60:
            return hour, minute
        return None

    def _loop(self) -> None:
        while not self._stop.wait(30.0):
            try:
                if not self.db.setting_bool("schedule_enabled"):
                    continue
                target = self._parse_time()
                if target is None:
                    continue
                now_local = dt.datetime.now(JST)
                today = now_local.strftime("%Y-%m-%d")
                if self.db.setting("_last_scheduled_date", "") == today:
                    continue
                scheduled = now_local.replace(hour=target[0], minute=target[1],
                                              second=0, microsecond=0)
                if now_local < scheduled:
                    continue
                if now_local - scheduled > dt.timedelta(hours=6):
                    # 6時間以上遅れている（PCが停止していた等）場合は当日分を諦める
                    self.db.set_setting("_last_scheduled_date", today)
                    continue
                if self.manager.running:
                    continue
                self.db.set_setting("_last_scheduled_date", today)
                self.db.audit("schedule.trigger", "", "", f"{today} {self.db.setting('schedule_time')}")
                self.manager.start(mode="scheduled")
            except Exception:  # noqa: BLE001
                try:
                    self.db.audit("schedule.error", "", "", traceback.format_exc()[:2000])
                except Exception:  # noqa: BLE001
                    pass

# ===========================================================================
# AI 注釈層（派生データ）
#
#   AIの役割は「収集済み原文の分類・要約」に限定する。
#   - 入力は必ず保存済みの原文テキスト（版で固定）だけ。Web検索等は使わない。
#   - 出力の各要点には原文からの逐語引用(quote)を必須とし、
#     引用が原文に実在するかをコード側で機械照合する（grounding 検証）。
#   - 照合に失敗した出力は grounding_status='failed' として保存し、
#     画面上でも「未検証」と明示する。事実としては一切採用しない。
# ===========================================================================

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models"
ANTHROPIC_VERSION = "2023-06-01"
SECRETS_PATH = os.path.join(DATA_DIR, "secrets.json")

AI_SYSTEM_PROMPT = """\
あなたは建築・換気設備業界の情報整理担当者です。与えられた「原文」だけを根拠に、\
分類と要約を行います。

厳守事項:
- 原文に書かれていないことを書いてはいけません。推測・補完・一般常識の追加は禁止です。
- key_points の各項目には、その根拠となる原文の一節を quote に一字一句そのまま写してください。
  要約・言い換え・記号の変更をした文字列を quote に入れてはいけません。
- 原文から判断できない場合は insufficient_evidence を true にし、summary は
  「原文からは判断できません」と書いてください。
- 金額・日付・型番・数値は原文にある表記をそのまま使い、単位や桁を変換しないでください。
- 会社の将来予測、影響の推測、営業上の助言は書かないでください。事実の整理だけを行います。
- 出力は日本語で、指定されたJSONスキーマに厳密に従ってください。
"""

AI_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "string",
            "description": "原文の内容を3文以内で要約した日本語テキスト。原文にない事実を含めないこと。",
        },
        "key_points": {
            "type": "array",
            "description": "原文から読み取れる要点。各要点は原文の逐語引用を伴うこと。",
            "items": {
                "type": "object",
                "properties": {
                    "point": {"type": "string", "description": "要点（日本語・1文）"},
                    "quote": {
                        "type": "string",
                        "description": "その要点の根拠となる原文の一節。原文からの一字一句の写し。",
                    },
                },
                "required": ["point", "quote"],
                "additionalProperties": False,
            },
        },
        "suggested_categories": {
            "type": "array",
            "description": "該当しそうな分類ラベル（候補であり確定ではない）",
            "items": {"type": "string"},
        },
        "uncertainty_notes": {
            "type": "string",
            "description": "原文だけでは確認できない点。無ければ空文字。",
        },
        "insufficient_evidence": {
            "type": "boolean",
            "description": "原文の情報が不足して判断できない場合は true。",
        },
    },
    "required": ["summary", "key_points", "suggested_categories",
                 "uncertainty_notes", "insufficient_evidence"],
    "additionalProperties": False,
}


def load_api_key() -> str:
    """APIキーは環境変数を最優先。無ければローカルの secrets.json（0600）を読む。"""
    key = os.environ.get(API_KEY_ENV, "").strip()
    if key:
        return key
    try:
        with open(SECRETS_PATH, "r", encoding="utf-8") as handle:
            return str(json.load(handle).get("anthropic_api_key", "")).strip()
    except (OSError, ValueError):
        return ""


def save_api_key(key: str) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    payload = {"anthropic_api_key": key.strip()}
    with open(SECRETS_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    try:
        os.chmod(SECRETS_PATH, 0o600)
    except OSError:
        pass


def _anthropic_post(url: str, payload: dict, api_key: str, timeout: int = 180) -> dict:
    """
    公式SDK(anthropic)が入っていればそれを使い、無ければ標準ライブラリで直接呼ぶ。
    このアプリは追加パッケージ無しで動くことを要件としているため両対応にしている。
    """
    try:
        import anthropic  # type: ignore
    except ImportError:
        anthropic = None  # noqa: N806

    if anthropic is not None and url == ANTHROPIC_API_URL:
        client = anthropic.Anthropic(api_key=api_key, timeout=float(timeout))
        message = client.messages.create(**payload)
        return json.loads(message.to_json())

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data if payload else None,
        method="POST" if payload else "GET",
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "user-agent": f"{APP_SLUG}/{APP_VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"Anthropic API HTTP {exc.code}: {body[:600]}") from exc


def _anthropic_get(url: str, api_key: str, timeout: int = 60) -> dict:
    request = urllib.request.Request(
        url,
        method="GET",
        headers={
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "user-agent": f"{APP_SLUG}/{APP_VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"Anthropic API HTTP {exc.code}: {body[:600]}") from exc


def list_models() -> list[dict]:
    api_key = load_api_key()
    if not api_key:
        raise RuntimeError("APIキーが未設定です")
    payload = _anthropic_get(ANTHROPIC_MODELS_URL + "?limit=50", api_key)
    return [
        {"id": item.get("id", ""), "display_name": item.get("display_name", "")}
        for item in payload.get("data", [])
    ]


def _quote_found(quote: str, haystack: str) -> bool:
    """引用が原文に実在するかを空白・全角半角の揺れを吸収して照合する。"""
    needle = re.sub(r"\s+", "", normalize_text(quote or "")).lower()
    if len(needle) < 6:
        return False
    return needle in haystack


def annotate_document(db: Database, document_id: int, *, actor: str = "") -> dict:
    """1件の文書にAI要約（派生データ）を付与する。"""
    document = db.one("SELECT * FROM documents WHERE id=?", (document_id,))
    if document is None:
        return {"ok": False, "error": "文書が見つかりません"}
    if not db.setting_bool("ai_enabled"):
        return {"ok": False, "error": "AI要約が無効です（設定画面で有効にしてください）"}

    model = (db.setting("ai_model") or "").strip()
    if not model:
        return {"ok": False, "error": "モデルIDが未設定です（設定画面で指定してください）"}
    api_key = load_api_key()
    if not api_key:
        return {"ok": False, "error": f"APIキーが未設定です（環境変数 {API_KEY_ENV} か設定画面）"}

    version_no = int(document["current_version"])
    existing = db.one(
        "SELECT id FROM ai_annotations WHERE document_id=? AND version_no=? "
        "AND grounding_status IN ('verified','failed') ORDER BY id DESC LIMIT 1",
        (document_id, version_no),
    )
    if existing is not None:
        return {"ok": True, "skipped": True, "message": "この版のAI要約は既に存在します"}

    max_chars = db.setting_int("ai_max_chars", 12000)
    source_text = (document["raw_text"] or "")[:max_chars]
    haystack = re.sub(r"\s+", "", normalize_text(source_text)).lower()

    user_content = (
        "以下は収集済みの原文です。原文だけを根拠に分類と要約を行ってください。\n\n"
        f"[情報元URL] {document['canonical_url']}\n"
        f"[取得日時(UTC)] {document['last_seen_at']}\n"
        f"[公開日] {document['published_at'] or '不明'}\n"
        f"[タイトル] {document['title']}\n"
        "[原文ここから]\n"
        f"{source_text}\n"
        "[原文ここまで]\n"
    )

    payload = {
        "model": model,
        "max_tokens": 2000,
        "system": AI_SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_content}],
        "output_config": {
            "format": {"type": "json_schema", "schema": AI_OUTPUT_SCHEMA},
        },
    }
    effort = (db.setting("ai_effort") or "").strip().lower()
    if effort in ("low", "medium", "high", "xhigh", "max"):
        payload["output_config"]["effort"] = effort

    request_hash = sha256_text(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    started = now_iso()

    try:
        response = _anthropic_post(ANTHROPIC_API_URL, payload, api_key)
    except Exception as exc:  # noqa: BLE001
        db.execute(
            "INSERT INTO ai_annotations(document_id, version_no, created_at, model, "
            "prompt_version, request_sha256, input_chars, grounding_status, error) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (document_id, version_no, started, model, PROMPT_VERSION, request_hash,
             len(source_text), "failed", str(exc)[:1000]),
        )
        db.audit("ai.error", "document", document_id, str(exc)[:500], actor=actor or None)
        return {"ok": False, "error": str(exc)[:500]}

    stop_reason = response.get("stop_reason", "")
    usage = response.get("usage") or {}
    if stop_reason == "refusal":
        details = response.get("stop_details") or {}
        message = f"モデルが応答を拒否しました（category={details.get('category')}）"
        db.execute(
            "INSERT INTO ai_annotations(document_id, version_no, created_at, model, "
            "prompt_version, request_sha256, input_chars, grounding_status, stop_reason, error) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (document_id, version_no, started, model, PROMPT_VERSION, request_hash,
             len(source_text), "failed", stop_reason, message),
        )
        return {"ok": False, "error": message}

    text_out = ""
    for block in response.get("content", []) or []:
        if isinstance(block, dict) and block.get("type") == "text":
            text_out = block.get("text", "")
            break

    try:
        parsed = json.loads(text_out)
    except (ValueError, TypeError):
        message = "モデル出力をJSONとして解釈できませんでした"
        db.execute(
            "INSERT INTO ai_annotations(document_id, version_no, created_at, model, "
            "prompt_version, request_sha256, input_chars, grounding_status, stop_reason, error) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (document_id, version_no, started, model, PROMPT_VERSION, request_hash,
             len(source_text), "failed", stop_reason, message),
        )
        return {"ok": False, "error": message}

    key_points = parsed.get("key_points") or []
    failed: list[dict] = []
    verified_points: list[dict] = []
    for item in key_points:
        if not isinstance(item, dict):
            continue
        quote = str(item.get("quote", ""))
        point = str(item.get("point", ""))
        if _quote_found(quote, haystack):
            verified_points.append({"point": point, "quote": quote, "grounded": True})
        else:
            failed.append({"point": point, "quote": quote})

    if failed:
        grounding = "failed"
    elif verified_points:
        grounding = "verified"
    else:
        grounding = "unverified"

    db.execute(
        "INSERT INTO ai_annotations(document_id, version_no, created_at, is_derived, model, "
        "prompt_version, request_sha256, input_chars, summary, key_points, "
        "suggested_categories, uncertainty_notes, insufficient_evidence, grounding_status, "
        "grounding_failed, stop_reason, input_tokens, output_tokens) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (document_id, version_no, started, 1, model, PROMPT_VERSION, request_hash,
         len(source_text), str(parsed.get("summary", ""))[:4000],
         json.dumps(verified_points, ensure_ascii=False),
         json.dumps(parsed.get("suggested_categories") or [], ensure_ascii=False),
         str(parsed.get("uncertainty_notes", ""))[:2000],
         1 if parsed.get("insufficient_evidence") else 0,
         grounding, json.dumps(failed, ensure_ascii=False), stop_reason,
         int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0)),
    )
    db.audit("ai.annotate", "document", document_id,
             f"model={model} grounding={grounding} failed={len(failed)}",
             actor=actor or None)
    return {
        "ok": True,
        "grounding_status": grounding,
        "verified": len(verified_points),
        "failed": len(failed),
    }


def auto_annotate(db: Database, limit: int = 20) -> dict:
    """収集直後に、高スコアかつ未要約の文書だけ自動でAI要約を作る。"""
    if not db.setting_bool("ai_enabled"):
        return {"ok": False, "error": "AI要約が無効です"}
    min_score = db.setting_int("ai_auto_min_score", 70)
    rows = db.query(
        "SELECT d.id FROM documents d "
        "WHERE d.priority_score >= ? AND d.review_status != 'reject' "
        "AND NOT EXISTS (SELECT 1 FROM ai_annotations a "
        "                WHERE a.document_id = d.id AND a.version_no = d.current_version) "
        "ORDER BY d.priority_score DESC, d.last_seen_at DESC LIMIT ?",
        (min_score, limit),
    )
    done = 0
    for row in rows:
        result = annotate_document(db, int(row["id"]), actor="auto")
        if result.get("ok"):
            done += 1
        time.sleep(0.5)
    return {"ok": True, "annotated": done, "candidates": len(rows)}

# ===========================================================================
# 検索・集計・エクスポート
# ===========================================================================


def _json_load(value: str | None, fallback):
    try:
        return json.loads(value) if value else fallback
    except (ValueError, TypeError):
        return fallback


def document_row_to_dict(row: sqlite3.Row, *, include_text: bool = False) -> dict:
    data = {
        "id": row["id"],
        "title": row["title"],
        "url": row["canonical_url"],
        "source_id": row["source_id"],
        "source_name": row["source_name"] if "source_name" in row.keys() else "",
        "source_tier": row["source_tier"] if "source_tier" in row.keys() else None,
        "maker": row["source_maker"] if "source_maker" in row.keys() else "",
        "published_at": row["published_at"],
        "published_at_raw": row["published_at_raw"],
        "published_at_source": row["published_at_source"],
        "first_seen_at": row["first_seen_at"],
        "last_seen_at": row["last_seen_at"],
        "last_changed_at": row["last_changed_at"],
        "current_version": row["current_version"],
        "priority_score": row["priority_score"],
        "review_status": row["review_status"],
        "primary_source_status": row["primary_source_status"],
        "primary_source_label": PRIMARY_STATUS_LABEL.get(row["primary_source_status"], "不明"),
        "primary_source_url": row["primary_source_url"],
        "evidence_note": row["evidence_note"],
        "duplicate_of": row["duplicate_of"],
        "text_len": row["text_len"],
        "content_sha256": row["content_sha256"],
    }
    keys = row.keys()
    if "categories" in keys:
        data["categories"] = _json_load(row["categories"], [])
        data["makers"] = _json_load(row["makers"], [])
        data["products"] = _json_load(row["products"], [])
        data["regions"] = _json_load(row["regions"], [])
        data["domain"] = row["domain"] or ""
    if "ai_grounding" in keys:
        data["ai_grounding"] = row["ai_grounding"] or ""
    if include_text:
        data["raw_text"] = row["raw_text"]
    else:
        data["excerpt"] = (row["raw_text"] or "")[:220]
    return data


DOCUMENT_SELECT = """
SELECT d.*, s.name AS source_name, s.tier AS source_tier, s.maker AS source_maker,
       c.categories, c.makers, c.products, c.regions, c.domain,
       (SELECT a.grounding_status FROM ai_annotations a
         WHERE a.document_id = d.id AND a.version_no = d.current_version
         ORDER BY a.id DESC LIMIT 1) AS ai_grounding
FROM documents d
LEFT JOIN sources s ON s.id = d.source_id
LEFT JOIN classifications c
       ON c.document_id = d.id AND c.version_no = d.current_version
"""


def search_documents(db: Database, params: dict) -> dict:
    where: list[str] = []
    args: list = []

    keyword = (params.get("q") or "").strip()
    if keyword:
        where.append("(d.title LIKE ? OR d.raw_text LIKE ? OR d.canonical_url LIKE ?)")
        like = f"%{keyword}%"
        args += [like, like, like]

    domain = (params.get("domain") or "").strip()
    if domain:
        where.append("(c.domain = ? OR c.domain = 'both')")
        args.append(domain)

    category = (params.get("category") or "").strip()
    if category:
        where.append("c.categories LIKE ?")
        args.append(f'%"{category}"%')

    maker = (params.get("maker") or "").strip()
    if maker:
        where.append("(c.makers LIKE ? OR s.maker = ?)")
        args += [f'%"{maker}"%', maker]

    region = (params.get("region") or "").strip()
    if region:
        where.append("c.regions LIKE ?")
        args.append(f'%"{region}"%')

    product = (params.get("product") or "").strip()
    if product:
        where.append("c.products LIKE ?")
        args.append(f'%"{product}"%')

    status = (params.get("status") or "").strip()
    if status:
        where.append("d.review_status = ?")
        args.append(status)

    primary = (params.get("primary") or "").strip()
    if primary:
        where.append("d.primary_source_status = ?")
        args.append(primary)

    try:
        days = int(params.get("days") or 0)
    except (TypeError, ValueError):
        days = 0
    if days > 0:
        where.append("(d.first_seen_at >= ? OR d.last_changed_at >= ?)")
        since = iso(now_utc() - dt.timedelta(days=days))
        args += [since, since]

    try:
        min_score = int(params.get("min_score") or 0)
    except (TypeError, ValueError):
        min_score = 0
    if min_score > 0:
        where.append("d.priority_score >= ?")
        args.append(min_score)

    if params.get("changed_only"):
        where.append("d.current_version > 1")

    if params.get("source_id"):
        where.append("d.source_id = ?")
        args.append(int(params["source_id"]))

    clause = ("WHERE " + " AND ".join(where)) if where else ""

    sort = (params.get("sort") or "score").strip()
    order = {
        "score": "d.priority_score DESC, COALESCE(d.last_changed_at, d.first_seen_at) DESC",
        "new": "d.first_seen_at DESC",
        "changed": "COALESCE(d.last_changed_at, d.first_seen_at) DESC",
        "published": "d.published_at IS NULL, d.published_at DESC, d.first_seen_at DESC",
    }.get(sort, "d.priority_score DESC, d.first_seen_at DESC")

    try:
        limit = max(1, min(500, int(params.get("limit") or 50)))
        offset = max(0, int(params.get("offset") or 0))
    except (TypeError, ValueError):
        limit, offset = 50, 0

    total_row = db.one(
        f"SELECT COUNT(*) AS n FROM documents d "
        f"LEFT JOIN sources s ON s.id=d.source_id "
        f"LEFT JOIN classifications c ON c.document_id=d.id AND c.version_no=d.current_version "
        f"{clause}",
        args,
    )
    rows = db.query(
        f"{DOCUMENT_SELECT} {clause} ORDER BY {order} LIMIT ? OFFSET ?",
        args + [limit, offset],
    )
    return {
        "total": int(total_row["n"]) if total_row else 0,
        "limit": limit,
        "offset": offset,
        "items": [document_row_to_dict(row) for row in rows],
    }


def dashboard_data(db: Database, days: int = 7) -> dict:
    since = iso(now_utc() - dt.timedelta(days=max(1, days)))
    counts = {
        "new": db.one("SELECT COUNT(*) n FROM documents WHERE first_seen_at>=?", (since,))["n"],
        "changed": db.one(
            "SELECT COUNT(*) n FROM documents WHERE last_changed_at>=? AND current_version>1",
            (since,))["n"],
        "unreviewed": db.one(
            "SELECT COUNT(*) n FROM documents WHERE review_status='new'")["n"],
        "documents": db.one("SELECT COUNT(*) n FROM documents")["n"],
        "sources_enabled": db.one("SELECT COUNT(*) n FROM sources WHERE enabled=1")["n"],
        "sources_total": db.one("SELECT COUNT(*) n FROM sources")["n"],
        "primary_unverified": db.one(
            "SELECT COUNT(*) n FROM documents WHERE primary_source_status='primary_unverified'"
        )["n"],
    }

    by_category: dict[str, int] = {}
    by_maker: dict[str, int] = {}
    by_region: dict[str, int] = {}
    rows = db.query(
        "SELECT c.categories, c.makers, c.regions FROM classifications c "
        "JOIN documents d ON d.id=c.document_id AND d.current_version=c.version_no "
        "WHERE d.first_seen_at>=? OR d.last_changed_at>=?",
        (since, since),
    )
    for row in rows:
        for name in _json_load(row["categories"], []):
            by_category[name] = by_category.get(name, 0) + 1
        for name in _json_load(row["makers"], []):
            by_maker[name] = by_maker.get(name, 0) + 1
        for name in _json_load(row["regions"], []):
            by_region[name] = by_region.get(name, 0) + 1

    top = db.query(
        f"{DOCUMENT_SELECT} WHERE (d.first_seen_at>=? OR d.last_changed_at>=?) "
        f"AND d.review_status != 'reject' "
        f"ORDER BY d.priority_score DESC, d.first_seen_at DESC LIMIT 15",
        (since, since),
    )
    runs = db.query("SELECT * FROM runs ORDER BY id DESC LIMIT 5")

    return {
        "days": days,
        "counts": counts,
        "by_category": sorted(by_category.items(), key=lambda kv: -kv[1])[:15],
        "by_maker": sorted(by_maker.items(), key=lambda kv: -kv[1])[:15],
        "by_region": sorted(by_region.items(), key=lambda kv: -kv[1])[:15],
        "top": [document_row_to_dict(row) for row in top],
        "runs": [dict(row) for row in runs],
    }


def document_detail(db: Database, document_id: int) -> dict | None:
    row = db.one(f"{DOCUMENT_SELECT} WHERE d.id=?", (document_id,))
    if row is None:
        return None
    data = document_row_to_dict(row, include_text=True)
    data["matched_terms"] = _json_load(
        (db.one("SELECT matched_terms FROM classifications WHERE document_id=? "
                "AND version_no=? ORDER BY id DESC LIMIT 1",
                (document_id, row["current_version"])) or {"matched_terms": "{}"})["matched_terms"],
        {},
    )
    data["versions"] = [
        {
            "version_no": v["version_no"],
            "captured_at": v["captured_at"],
            "content_sha256": v["content_sha256"],
            "added_lines": v["added_lines"],
            "removed_lines": v["removed_lines"],
            "change_kinds": _json_load(v["change_kinds"], []),
            "diff_unified": v["diff_unified"],
            "title": v["title"],
        }
        for v in db.query(
            "SELECT * FROM document_versions WHERE document_id=? ORDER BY version_no DESC",
            (document_id,),
        )
    ]
    data["ai"] = [
        {
            "id": a["id"],
            "created_at": a["created_at"],
            "version_no": a["version_no"],
            "model": a["model"],
            "prompt_version": a["prompt_version"],
            "summary": a["summary"],
            "key_points": _json_load(a["key_points"], []),
            "suggested_categories": _json_load(a["suggested_categories"], []),
            "uncertainty_notes": a["uncertainty_notes"],
            "insufficient_evidence": bool(a["insufficient_evidence"]),
            "grounding_status": a["grounding_status"],
            "grounding_failed": _json_load(a["grounding_failed"], []),
            "input_tokens": a["input_tokens"],
            "output_tokens": a["output_tokens"],
            "error": a["error"],
            "is_derived": bool(a["is_derived"]),
        }
        for a in db.query(
            "SELECT * FROM ai_annotations WHERE document_id=? ORDER BY id DESC", (document_id,)
        )
    ]
    # この文書のURLに対する取得ログ（＝エビデンスの取得証跡）だけを厳密一致で拾う
    data["fetch_logs"] = [
        dict(log) for log in db.query(
            "SELECT id, run_key, url, started_at, finished_at, http_status, robots_decision, "
            "bytes, content_sha256, user_agent, error FROM fetch_logs "
            "WHERE url = ? OR url = ? ORDER BY id DESC LIMIT 20",
            (row["url"], row["canonical_url"]),
        )
    ]
    source = db.one("SELECT * FROM sources WHERE id=?", (row["source_id"],)) if row["source_id"] else None
    data["source"] = dict(source) if source else None
    data["has_raw_html"] = bool(row["raw_html"])
    return data


EXPORT_COLUMNS = [
    ("id", "文書ID"),
    ("title", "タイトル"),
    ("url", "情報元URL"),
    ("source_name", "情報源"),
    ("source_tier", "情報源ティア"),
    ("primary_source_label", "一次情報判定"),
    ("published_at", "公開日(UTC)"),
    ("first_seen_at", "初回取得日時(UTC)"),
    ("last_seen_at", "最終取得日時(UTC)"),
    ("last_changed_at", "最終変更日時(UTC)"),
    ("current_version", "版"),
    ("priority_score", "優先度"),
    ("domain", "領域"),
    ("categories", "分類"),
    ("makers", "メーカー"),
    ("products", "商品分野"),
    ("regions", "地域"),
    ("review_status", "確認状態"),
    ("content_sha256", "本文SHA256"),
    ("excerpt", "本文抜粋"),
]


def export_documents(db: Database, params: dict, fmt: str) -> tuple[str, str, bytes]:
    """戻り値: (filename, content_type, body)"""
    params = dict(params)
    params["limit"] = 500
    collected: list[dict] = []
    offset = 0
    while True:
        params["offset"] = offset
        page = search_documents(db, params)
        collected.extend(page["items"])
        offset += page["limit"]
        if offset >= page["total"] or offset >= 5000:
            break

    stamp = dt.datetime.now(JST).strftime("%Y%m%d-%H%M")
    if fmt == "json":
        body = json.dumps(
            {"exported_at": now_iso(), "count": len(collected), "items": collected},
            ensure_ascii=False, indent=2,
        ).encode("utf-8")
        return f"kanki-intel-{stamp}.json", "application/json; charset=utf-8", body

    if fmt == "md":
        lines = [f"# 収集レポート {dt.datetime.now(JST).strftime('%Y-%m-%d %H:%M')} (JST)",
                 "", f"件数: {len(collected)}", ""]
        for item in collected:
            lines.append(f"## [{item['priority_score']}] {item['title']}")
            lines.append("")
            lines.append(f"- 情報元: {item['url']}")
            lines.append(f"- 情報源: {item.get('source_name') or '(未登録)'} / "
                         f"ティア{item.get('source_tier')} / {item['primary_source_label']}")
            lines.append(f"- 公開日: {item.get('published_at') or '不明'}")
            lines.append(f"- 初回取得: {item['first_seen_at']} / 版: {item['current_version']}")
            lines.append(f"- 分類: {', '.join(item.get('categories') or []) or '—'}")
            lines.append(f"- メーカー: {', '.join(item.get('makers') or []) or '—'}")
            lines.append(f"- 地域: {', '.join(item.get('regions') or []) or '—'}")
            lines.append("")
            lines.append(f"> {(item.get('excerpt') or '').replace(chr(10), ' ')}")
            lines.append("")
        body = "\n".join(lines).encode("utf-8")
        return f"kanki-intel-{stamp}.md", "text/markdown; charset=utf-8", body

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow([label for _key, label in EXPORT_COLUMNS])
    for item in collected:
        row = []
        for key, _label in EXPORT_COLUMNS:
            value = item.get(key, "")
            if isinstance(value, list):
                value = "; ".join(str(v) for v in value)
            if isinstance(value, str):
                value = value.replace("\r", " ").replace("\n", " ")
            row.append(value)
        writer.writerow(row)
    # Excel での文字化けを避けるため BOM 付き UTF-8 で出力する
    body = "﻿".encode("utf-8") + buffer.getvalue().encode("utf-8")
    return f"kanki-intel-{stamp}.csv", "text/csv; charset=utf-8", body


# ===========================================================================
# 監視対象の初期リスト
#   重要: URLは運用者が公式サイトで確認してから登録する運用にしている。
#   ここに入る行は全て enabled=0 / url_verified=0 で、確認するまで一切取得しない。
# ===========================================================================

SEED_SOURCES = [
    # --- 優先監視メーカー（要件 2-2） ---------------------------------------
    *[
        {
            "source_key": f"maker-{index:02d}",
            "name": f"{maker} 公式サイト（お知らせ／製品情報）",
            "maker": maker,
            "domain": "maker",
            "url": "",
            "source_type": "html_list",
            "tier": 1,
            "region": "",
            "note": "公式サイトのお知らせ/新着情報ページURLを運用者が確認して登録してください。"
                    "URL未確認・利用規約未確認の状態では収集されません。",
        }
        for index, maker in enumerate(WATCH_MAKERS.keys(), start=1)
    ],
    # --- 官公庁・自治体（ティア2） ------------------------------------------
    {"source_key": "gov-mlit", "name": "国土交通省 報道発表・法令改正",
     "maker": "", "domain": "construction", "url": "https://www.mlit.go.jp/",
     "source_type": "html_list", "tier": 2, "region": "全国",
     "note": "報道発表一覧の実URLを確認のうえ登録してください（建築基準法・省エネ法改正の一次情報）。"},
    {"source_key": "gov-meti", "name": "経済産業省 ニュースリリース",
     "maker": "", "domain": "construction", "url": "https://www.meti.go.jp/",
     "source_type": "html_list", "tier": 2, "region": "全国",
     "note": "建材・省エネ関連の一次情報。実URLを確認のうえ登録してください。"},
    {"source_key": "gov-tokyo", "name": "東京都 入札・都市整備情報",
     "maker": "", "domain": "construction", "url": "https://www.metro.tokyo.lg.jp/",
     "source_type": "html_list", "tier": 2, "region": "東京都",
     "note": "入札公告／都市整備局の該当ページURLを確認のうえ登録してください。"},
    {"source_key": "gov-saitama", "name": "埼玉県 入札・建築情報",
     "maker": "", "domain": "construction", "url": "", "source_type": "html_list",
     "tier": 2, "region": "埼玉県", "note": "県公式サイトの入札情報ページURLを登録してください。"},
    {"source_key": "gov-chiba", "name": "千葉県 入札・建築情報",
     "maker": "", "domain": "construction", "url": "", "source_type": "html_list",
     "tier": 2, "region": "千葉県", "note": "県公式サイトの入札情報ページURLを登録してください。"},
    {"source_key": "gov-kanagawa", "name": "神奈川県 入札・建築情報",
     "maker": "", "domain": "construction", "url": "", "source_type": "html_list",
     "tier": 2, "region": "神奈川県", "note": "県公式サイトの入札情報ページURLを登録してください。"},
    {"source_key": "gov-ibaraki", "name": "茨城県 入札・建築情報",
     "maker": "", "domain": "construction", "url": "", "source_type": "html_list",
     "tier": 2, "region": "茨城県", "note": "県公式サイトの入札情報ページURLを登録してください。"},
    {"source_key": "gov-tochigi", "name": "栃木県 入札・建築情報",
     "maker": "", "domain": "construction", "url": "", "source_type": "html_list",
     "tier": 2, "region": "栃木県", "note": "県公式サイトの入札情報ページURLを登録してください。"},
    {"source_key": "gov-gunma", "name": "群馬県 入札・建築情報",
     "maker": "", "domain": "construction", "url": "", "source_type": "html_list",
     "tier": 2, "region": "群馬県", "note": "県公式サイトの入札情報ページURLを登録してください。"},
    # --- 業界団体（ティア3） -------------------------------------------------
    {"source_key": "assoc-hvac", "name": "空調・換気関連 業界団体（お知らせ）",
     "maker": "", "domain": "both", "url": "", "source_type": "html_list", "tier": 3,
     "region": "全国", "note": "日本冷凍空調工業会等、監視したい団体のお知らせページを登録してください。"},
    {"source_key": "assoc-building", "name": "建築・設備関連 業界団体（お知らせ）",
     "maker": "", "domain": "construction", "url": "", "source_type": "html_list", "tier": 3,
     "region": "全国", "note": "建築設備技術者協会等。団体サイトの利用規約を確認のうえ登録してください。"},
    # --- 専門媒体・IR（ティア4/5） ------------------------------------------
    {"source_key": "media-construction", "name": "建設業界 専門媒体（RSS）",
     "maker": "", "domain": "construction", "url": "", "source_type": "rss", "tier": 4,
     "region": "全国",
     "note": "媒体のRSS配信URLを登録してください。転載のみで構成された記事は正本にしないでください。"},
    {"source_key": "ir-disclosure", "name": "上場企業 IR・適時開示",
     "maker": "", "domain": "both", "url": "", "source_type": "html_list", "tier": 5,
     "region": "全国", "note": "監視したい企業のIRページ／適時開示ページを登録してください。"},
]


def seed_sources(db: Database) -> int:
    """初期の監視対象リストを投入する（既存キーは触らない）。"""
    inserted = 0
    timestamp = now_iso()
    for item in SEED_SOURCES:
        exists = db.one("SELECT id FROM sources WHERE source_key=?", (item["source_key"],))
        if exists:
            continue
        db.execute(
            "INSERT INTO sources(source_key, name, maker, domain, url, source_type, tier, "
            "region, note, enabled, url_verified, terms_confirmed, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,0,0,0,?,?)",
            (item["source_key"], item["name"], item.get("maker", ""), item["domain"],
             item.get("url", ""), item["source_type"], item["tier"], item.get("region", ""),
             item.get("note", ""), timestamp, timestamp),
        )
        inserted += 1
    if inserted:
        db.audit("source.seed", "", "", f"{inserted}件の監視対象候補を追加（全て停止状態）")
    return inserted

# ===========================================================================
# ローカル Web サーバ（127.0.0.1 のみ / トークン認証つき）
# ===========================================================================


class AppContext:
    def __init__(self, db: Database):
        self.db = db
        self.manager = CollectionManager(db)
        self.scheduler = Scheduler(db, self.manager)
        self.token = uuid.uuid4().hex


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def _source_payload(row: sqlite3.Row) -> dict:
    data = dict(row)
    data["tier_label"] = SOURCE_TIERS.get(int(row["tier"] or 1), "不明")
    data["ready"] = bool(row["url"]) and bool(row["url_verified"]) and bool(row["terms_confirmed"])
    return data


def _require_operator(db: Database) -> str:
    operator = (db.setting("operator") or "").strip()
    return operator or "unknown"


def api_dispatch(ctx: AppContext, method: str, path: str, query: dict, body: dict):
    db = ctx.db

    # ---- 状態 -------------------------------------------------------------
    if path == "/api/state" and method == "GET":
        settings = db.settings()
        settings.pop("_last_scheduled_date", None)
        return {
            "app": {"name": APP_NAME, "version": APP_VERSION,
                    "classifier_version": CLASSIFIER_VERSION,
                    "db_path": db.path, "data_dir": DATA_DIR},
            "settings": settings,
            "api_key_present": bool(load_api_key()),
            "api_key_from_env": bool(os.environ.get(API_KEY_ENV, "").strip()),
            "collect": ctx.manager.state,
            "next_scheduled_run": ctx.scheduler.next_run_at(),
            "vocab": {
                "project_categories": list(PROJECT_CATEGORIES.keys()),
                "maker_categories": list(MAKER_CATEGORIES.keys()),
                "makers": list(WATCH_MAKERS.keys()),
                "products": list(PRODUCT_TERMS.keys()),
                "regions": PRIORITY_REGIONS + ["全国"],
                "tiers": SOURCE_TIERS,
            },
        }

    if path == "/api/dashboard" and method == "GET":
        try:
            days = int(query.get("days", ["7"])[0])
        except (TypeError, ValueError):
            days = 7
        return dashboard_data(db, days)

    # ---- 文書 -------------------------------------------------------------
    if path == "/api/documents" and method == "GET":
        params = {key: values[0] for key, values in query.items() if values}
        return search_documents(db, params)

    match = re.match(r"^/api/documents/(\d+)$", path)
    if match and method == "GET":
        detail = document_detail(db, int(match.group(1)))
        if detail is None:
            raise ApiError("文書が見つかりません", 404)
        return detail

    match = re.match(r"^/api/documents/(\d+)/review$", path)
    if match and method == "POST":
        document_id = int(match.group(1))
        status = str(body.get("status", "")).strip()
        if status not in ("new", "keep", "reject", "pending"):
            raise ApiError("確認状態の値が不正です")
        note = str(body.get("note", ""))[:2000]
        actor = _require_operator(db)
        db.execute(
            "UPDATE documents SET review_status=?, review_note=?, review_actor=?, review_at=? "
            "WHERE id=?",
            (status, note, actor, now_iso(), document_id),
        )
        db.audit("document.review", "document", document_id, f"{status} / {note}")
        return {"ok": True}

    match = re.match(r"^/api/documents/(\d+)/ai$", path)
    if match and method == "POST":
        return annotate_document(db, int(match.group(1)), actor=_require_operator(db))

    match = re.match(r"^/api/documents/(\d+)/raw$", path)
    if match and method == "GET":
        row = db.one("SELECT raw_html, canonical_url FROM documents WHERE id=?",
                     (int(match.group(1)),))
        if row is None:
            raise ApiError("文書が見つかりません", 404)
        raw = decompress(row["raw_html"])
        if not raw:
            raw = "(保存された原文HTMLがありません)".encode("utf-8")
        return {"__raw__": raw, "__content_type__": "text/plain; charset=utf-8"}

    # ---- 情報源 -----------------------------------------------------------
    if path == "/api/sources" and method == "GET":
        rows = db.query("SELECT * FROM sources ORDER BY tier, name")
        return {"items": [_source_payload(row) for row in rows]}

    if path == "/api/sources" and method == "POST":
        return api_save_source(db, body)

    match = re.match(r"^/api/sources/(\d+)$", path)
    if match and method == "DELETE":
        source_id = int(match.group(1))
        row = db.one("SELECT name FROM sources WHERE id=?", (source_id,))
        if row is None:
            raise ApiError("情報源が見つかりません", 404)
        db.execute("DELETE FROM sources WHERE id=?", (source_id,))
        db.audit("source.delete", "source", source_id, row["name"])
        return {"ok": True}

    match = re.match(r"^/api/sources/(\d+)/robots$", path)
    if match and method == "POST":
        source_id = int(match.group(1))
        row = db.one("SELECT * FROM sources WHERE id=?", (source_id,))
        if row is None:
            raise ApiError("情報源が見つかりません", 404)
        if not row["url"]:
            raise ApiError("監視URLが未登録です")
        denied = is_denied_source(row["url"])
        if denied:
            db.execute("UPDATE sources SET robots_decision=?, robots_checked_at=? WHERE id=?",
                       (f"denied-by-policy: {denied}", now_iso(), source_id))
            return {"ok": False, "decision": f"利用不可: {denied}"}
        fetcher = Fetcher(db)
        allowed, decision = fetcher.robots.can_fetch(row["url"])
        delay = fetcher.robots.crawl_delay(row["url"])
        db.execute("UPDATE sources SET robots_decision=?, robots_checked_at=? WHERE id=?",
                   (decision[:500], now_iso(), source_id))
        db.audit("source.robots_check", "source", source_id, decision[:500])
        return {"ok": allowed, "decision": decision, "crawl_delay": delay}

    if path == "/api/sources/seed" and method == "POST":
        return {"ok": True, "inserted": seed_sources(db)}

    # ---- 収集 -------------------------------------------------------------
    if path == "/api/collect" and method == "POST":
        source_ids = body.get("source_ids") or None
        if source_ids:
            source_ids = [int(v) for v in source_ids]
        return ctx.manager.start(mode="manual", source_ids=source_ids)

    if path == "/api/collect/cancel" and method == "POST":
        return ctx.manager.cancel()

    if path == "/api/runs" and method == "GET":
        return {"items": [dict(row) for row in
                          db.query("SELECT * FROM runs ORDER BY id DESC LIMIT 50")]}

    if path == "/api/fetch-logs" and method == "GET":
        return {"items": [dict(row) for row in db.query(
            "SELECT * FROM fetch_logs ORDER BY id DESC LIMIT 200")]}

    if path == "/api/audit" and method == "GET":
        return {"items": [dict(row) for row in
                          db.query("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300")]}

    # ---- 設定 -------------------------------------------------------------
    if path == "/api/settings" and method == "POST":
        changed = []
        for key, value in (body.get("settings") or {}).items():
            if key not in DEFAULT_SETTINGS:
                continue
            db.set_setting(key, str(value))
            changed.append(key)
        if "api_key" in body:
            key = str(body["api_key"]).strip()
            if key:
                save_api_key(key)
                changed.append("api_key")
            elif body.get("clear_api_key"):
                save_api_key("")
                changed.append("api_key(clear)")
        db.audit("settings.update", "", "", ",".join(changed))
        return {"ok": True, "changed": changed}

    if path == "/api/models" and method == "GET":
        try:
            return {"ok": True, "items": list_models()}
        except Exception as exc:  # noqa: BLE001
            raise ApiError(str(exc)[:500]) from exc

    if path == "/api/ai/auto" and method == "POST":
        return auto_annotate(db)

    # ---- エクスポート -----------------------------------------------------
    if path == "/api/export" and method == "GET":
        params = {key: values[0] for key, values in query.items() if values}
        fmt = params.pop("format", "csv")
        if fmt not in ("csv", "json", "md"):
            raise ApiError("format は csv / json / md のいずれかです")
        filename, content_type, payload = export_documents(db, params, fmt)
        db.audit("export", "", "", f"{fmt} / {len(payload)} bytes")
        return {"__raw__": payload, "__content_type__": content_type,
                "__filename__": filename}

    raise ApiError("エンドポイントが見つかりません", 404)


def api_save_source(db: Database, body: dict) -> dict:
    source_id = body.get("id")
    url = str(body.get("url", "")).strip()
    if url:
        if not url.startswith(("http://", "https://")):
            raise ApiError("URLは http:// または https:// で始めてください")
        denied = is_denied_source(url)
        if denied:
            raise ApiError(f"この情報源は正本として登録できません: {denied}")

    name = str(body.get("name", "")).strip()
    if not name:
        raise ApiError("対象名は必須です")

    source_type = str(body.get("source_type", "html")).strip()
    if source_type not in ("rss", "html", "html_list", "auto"):
        raise ApiError("種別は rss / html / html_list / auto のいずれかです")

    try:
        tier = int(body.get("tier", 1))
    except (TypeError, ValueError):
        tier = 1
    if tier not in SOURCE_TIERS:
        raise ApiError("情報源ティアは1〜6で指定してください")

    url_verified = 1 if body.get("url_verified") else 0
    terms_confirmed = 1 if body.get("terms_confirmed") else 0
    enabled = 1 if body.get("enabled") else 0
    if enabled and not (url and url_verified and terms_confirmed):
        raise ApiError("有効化するには URL・URL確認済・利用規約確認済 の全てが必要です")

    actor = _require_operator(db)
    fields = {
        "name": name,
        "maker": str(body.get("maker", "")).strip(),
        "domain": str(body.get("domain", "construction")).strip() or "construction",
        "url": url,
        "source_type": source_type,
        "tier": tier,
        "region": str(body.get("region", "")).strip(),
        "category_hint": str(body.get("category_hint", "")).strip(),
        "enabled": enabled,
        "url_verified": url_verified,
        "terms_url": str(body.get("terms_url", "")).strip(),
        "terms_confirmed": terms_confirmed,
        "crawl_interval_min": max(60, int(body.get("crawl_interval_min", 1440) or 1440)),
        "min_interval_sec": max(1, int(body.get("min_interval_sec", 5) or 5)),
        "max_pages": max(1, min(100, int(body.get("max_pages", 12) or 12))),
        "link_filter": str(body.get("link_filter", "")).strip(),
        "note": str(body.get("note", ""))[:2000],
        "updated_at": now_iso(),
    }
    if terms_confirmed:
        fields["terms_confirmed_by"] = actor
        fields["terms_confirmed_at"] = now_iso()

    if source_id:
        assignments = ", ".join(f"{key}=?" for key in fields)
        db.execute(f"UPDATE sources SET {assignments} WHERE id=?",
                   list(fields.values()) + [int(source_id)])
        db.audit("source.update", "source", source_id, f"{name} enabled={enabled}")
        return {"ok": True, "id": int(source_id)}

    key = str(body.get("source_key", "")).strip() or f"src-{uuid.uuid4().hex[:8]}"
    if db.one("SELECT id FROM sources WHERE source_key=?", (key,)):
        raise ApiError(f"情報源ID '{key}' は既に使われています")
    fields["source_key"] = key
    fields["created_at"] = now_iso()
    columns = ", ".join(fields)
    placeholders = ", ".join("?" for _ in fields)
    cur = db.execute(f"INSERT INTO sources({columns}) VALUES({placeholders})",
                     list(fields.values()))
    db.audit("source.create", "source", cur.lastrowid, f"{name} ({key})")
    return {"ok": True, "id": int(cur.lastrowid)}


class RequestHandler(http.server.BaseHTTPRequestHandler):
    server_version = f"{APP_SLUG}/{APP_VERSION}"
    protocol_version = "HTTP/1.1"
    ctx: AppContext = None  # type: ignore[assignment]

    def log_message(self, fmt, *args):  # 標準の逐次ログは抑制する
        return

    # -- 認証 ---------------------------------------------------------------
    def _authorized(self, parsed) -> bool:
        token = self.ctx.token
        query = urllib.parse.parse_qs(parsed.query)
        if query.get("t", [""])[0] == token:
            return True
        header = self.headers.get("X-App-Token", "")
        if header == token:
            return True
        cookie_header = self.headers.get("Cookie", "")
        if cookie_header:
            cookies = http.cookies.SimpleCookie()
            try:
                cookies.load(cookie_header)
            except http.cookies.CookieError:
                return False
            morsel = cookies.get("kanki_token")
            if morsel and morsel.value == token:
                return True
        return False

    # -- 応答ヘルパ ---------------------------------------------------------
    def _send(self, status: int, content_type: str, payload: bytes,
              extra_headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_json(self, status: int, data) -> None:
        payload = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self._send(status, "application/json; charset=utf-8", payload)

    # -- ルーティング -------------------------------------------------------
    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            if not self._authorized(parsed):
                self._send(403, "text/html; charset=utf-8",
                           "<h1>403</h1><p>アクセストークンが必要です。"
                           "起動時に表示されたURLからアクセスしてください。</p>".encode("utf-8"))
                return
            cookie = f"kanki_token={self.ctx.token}; Path=/; SameSite=Strict; HttpOnly"
            self._send(200, "text/html; charset=utf-8", INDEX_HTML.encode("utf-8"),
                       {"Set-Cookie": cookie})
            return

        if path == "/healthz":
            self._send_json(200, {"ok": True, "version": APP_VERSION})
            return

        if not path.startswith("/api/"):
            self._send(404, "text/plain; charset=utf-8", b"not found")
            return

        if not self._authorized(parsed):
            self._send_json(403, {"error": "認証されていません"})
            return

        query = urllib.parse.parse_qs(parsed.query)
        self._handle_api("GET", path, query, {})

    def do_POST(self):  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        if not path.startswith("/api/"):
            self._send(404, "text/plain; charset=utf-8", b"not found")
            return
        if not self._authorized(parsed):
            self._send_json(403, {"error": "認証されていません"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8")) if raw.strip() else {}
        except ValueError:
            self._send_json(400, {"error": "JSONの解析に失敗しました"})
            return
        query = urllib.parse.parse_qs(parsed.query)
        self._handle_api("POST", path, query, body)

    def do_DELETE(self):  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if not parsed.path.startswith("/api/"):
            self._send(404, "text/plain; charset=utf-8", b"not found")
            return
        if not self._authorized(parsed):
            self._send_json(403, {"error": "認証されていません"})
            return
        self._handle_api("DELETE", parsed.path, urllib.parse.parse_qs(parsed.query), {})

    def _handle_api(self, method: str, path: str, query: dict, body: dict) -> None:
        try:
            result = api_dispatch(self.ctx, method, path, query, body)
        except ApiError as exc:
            self._send_json(exc.status, {"error": exc.message})
            return
        except Exception as exc:  # noqa: BLE001
            try:
                self.ctx.db.audit("api.error", "", path, traceback.format_exc()[:2000])
            except Exception:  # noqa: BLE001
                pass
            self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})
            return

        if isinstance(result, dict) and "__raw__" in result:
            headers = {}
            if result.get("__filename__"):
                quoted = urllib.parse.quote(result["__filename__"])
                headers["Content-Disposition"] = (
                    f"attachment; filename*=UTF-8''{quoted}"
                )
            self._send(200, result.get("__content_type__", "application/octet-stream"),
                       result["__raw__"], headers)
            return
        self._send_json(200, result)


class LocalServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def pick_port(preferred: int = 8787) -> int:
    for port in [preferred] + list(range(8788, 8830)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("利用可能なポートが見つかりませんでした")

# ===========================================================================
# 管理画面（単一ファイルに埋め込み。外部CDNを一切参照しない）
# ===========================================================================

INDEX_HTML = r'''<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>建築・換気口業界 情報収集デスク</title>
<style>
:root{
  --bg:#f4f6f9; --panel:#ffffff; --ink:#16202b; --muted:#5c6b7a; --line:#dde3ea;
  --accent:#12507e; --accent-soft:#e7f0f8; --ok:#0f7b4f; --warn:#a15c00; --bad:#b3261e;
  --shadow:0 1px 2px rgba(16,32,48,.06),0 4px 14px rgba(16,32,48,.06);
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#11161c; --panel:#171e26; --ink:#e6edf4; --muted:#98a6b5; --line:#26313d;
         --accent:#63a6dc; --accent-soft:#1b2a38; --ok:#4cc38a; --warn:#e0a458; --bad:#f0736a;
         --shadow:0 1px 2px rgba(0,0,0,.4); }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Noto Sans JP",Meiryo,sans-serif;
  font-size:14px;line-height:1.65}
header{position:sticky;top:0;z-index:20;background:var(--panel);border-bottom:1px solid var(--line);
  padding:10px 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;box-shadow:var(--shadow)}
header h1{font-size:15px;margin:0;font-weight:700;letter-spacing:.02em}
header .sub{color:var(--muted);font-size:12px}
nav{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}
nav button{background:transparent;border:1px solid transparent;color:var(--muted);
  padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600}
nav button:hover{background:var(--accent-soft);color:var(--ink)}
nav button.active{background:var(--accent);color:#fff}
main{padding:18px;max-width:1500px;margin:0 auto}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;
  margin-bottom:16px;box-shadow:var(--shadow)}
.panel h2{margin:0 0 12px;font-size:14px;letter-spacing:.04em;color:var(--muted);
  text-transform:none;font-weight:700}
.grid{display:grid;gap:12px}
.kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi .n{font-size:26px;font-weight:700;line-height:1.2}
.kpi .l{font-size:12px;color:var(--muted)}
button,select,input,textarea{font:inherit;color:inherit}
.btn{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:7px 14px;
  cursor:pointer;font-weight:600;font-size:13px}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
.btn.danger{background:var(--bad)}
.btn.sm{padding:4px 9px;font-size:12px}
input[type=text],input[type=number],input[type=password],select,textarea{
  background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 9px;width:100%}
textarea{min-height:64px;resize:vertical}
label.f{display:block;margin-bottom:10px}
label.f > span{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}
label.chk{display:flex;gap:7px;align-items:flex-start;margin-bottom:9px;font-size:13px}
label.chk input{margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-size:12px;font-weight:700;white-space:nowrap}
tr.clickable{cursor:pointer}
tr.clickable:hover td{background:var(--accent-soft)}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;
  background:var(--accent-soft);color:var(--accent);margin:1px 3px 1px 0;font-weight:600;
  border:1px solid transparent;white-space:nowrap}
.tag.ok{background:rgba(15,123,79,.12);color:var(--ok)}
.tag.warn{background:rgba(161,92,0,.12);color:var(--warn)}
.tag.bad{background:rgba(179,38,30,.12);color:var(--bad)}
.tag.plain{background:transparent;border-color:var(--line);color:var(--muted)}
.score{display:inline-block;min-width:34px;text-align:center;font-weight:700;border-radius:6px;
  padding:1px 6px;font-size:12px;background:var(--accent-soft);color:var(--accent)}
.score.hi{background:rgba(179,38,30,.14);color:var(--bad)}
.score.mid{background:rgba(161,92,0,.14);color:var(--warn)}
.muted{color:var(--muted)}
.small{font-size:12px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;
  word-break:break-all}
.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;
  align-items:end}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.spread{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.drawer{position:fixed;inset:0;background:rgba(10,16,22,.45);z-index:40;display:none}
.drawer.open{display:block}
.drawer-inner{position:absolute;right:0;top:0;bottom:0;width:min(940px,100%);
  background:var(--panel);overflow:auto;padding:20px;border-left:1px solid var(--line)}
.modal{position:fixed;inset:0;background:rgba(10,16,22,.45);z-index:50;display:none;
  align-items:flex-start;justify-content:center;padding:24px;overflow:auto}
.modal.open{display:flex}
.modal-inner{background:var(--panel);border-radius:12px;padding:20px;width:min(760px,100%);
  border:1px solid var(--line)}
pre.diff{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;
  overflow:auto;max-height:340px;font-size:12px;line-height:1.55;white-space:pre-wrap;
  word-break:break-all}
pre.diff .add{color:var(--ok)} pre.diff .del{color:var(--bad)} pre.diff .hd{color:var(--muted)}
pre.raw{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;
  max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:13px}
.bar{height:8px;background:var(--accent-soft);border-radius:4px;overflow:hidden}
.bar > i{display:block;height:100%;background:var(--accent)}
.notice{border-left:3px solid var(--accent);background:var(--accent-soft);padding:9px 12px;
  border-radius:0 8px 8px 0;font-size:13px;margin-bottom:12px}
.notice.warn{border-color:var(--warn);background:rgba(161,92,0,.10)}
.notice.bad{border-color:var(--bad);background:rgba(179,38,30,.10)}
.derived{border:1px dashed var(--warn);border-radius:10px;padding:12px;
  background:rgba(161,92,0,.06);margin-bottom:10px}
.derived h4{margin:0 0 6px;font-size:13px;color:var(--warn)}
#toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ink);
  color:var(--bg);padding:9px 16px;border-radius:9px;font-size:13px;z-index:80;display:none;
  max-width:80vw}
.kv{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;font-size:13px}
.kv dt{color:var(--muted)}
.kv dd{margin:0;word-break:break-all}
.split{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width:900px){.split{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <h1>建築・換気口業界 情報収集デスク</h1>
  <span class="sub" id="verline"></span>
  <nav>
    <button data-tab="dash" class="active">ダッシュボード</button>
    <button data-tab="docs">案件・記事</button>
    <button data-tab="sources">情報源管理</button>
    <button data-tab="runs">実行ログ</button>
    <button data-tab="audit">監査ログ</button>
    <button data-tab="settings">設定</button>
  </nav>
  <button class="btn" id="btnCollect">収集を実行</button>
</header>

<main>
  <div class="notice" id="principle">
    <b>運用原則</b>：正本は収集した原文。AI要約は<b>派生データ</b>として区別して表示します。
    情報元URL・取得日時・公開日・原文・差分履歴を保存し、根拠を後から確認できます。
    robots.txt と利用規約を確認した情報源だけを収集し、会員限定情報の取得や認証回避は行いません。
  </div>

  <!-- ダッシュボード -->
  <section id="tab-dash">
    <div class="panel">
      <div class="spread">
        <h2 style="margin:0">サマリ</h2>
        <div class="row">
          <select id="dashDays" style="width:auto">
            <option value="1">過去24時間</option>
            <option value="3">過去3日</option>
            <option value="7" selected>過去7日</option>
            <option value="30">過去30日</option>
          </select>
          <button class="btn ghost sm" id="btnReloadDash">更新</button>
        </div>
      </div>
      <div class="grid kpis" id="kpis" style="margin-top:12px"></div>
    </div>
    <div class="split">
      <div class="panel"><h2>分類別</h2><div id="byCategory"></div></div>
      <div class="panel"><h2>メーカー別 / 地域別</h2><div id="byMakerRegion"></div></div>
    </div>
    <div class="panel">
      <h2>優先度の高い新着・更新</h2>
      <div id="dashTop"></div>
    </div>
  </section>

  <!-- 案件・記事 -->
  <section id="tab-docs" hidden>
    <div class="panel">
      <div class="filters">
        <label class="f"><span>キーワード</span><input type="text" id="fq" placeholder="型番・案件名・地名など"></label>
        <label class="f"><span>領域</span><select id="fdomain"></select></label>
        <label class="f"><span>分類</span><select id="fcategory"></select></label>
        <label class="f"><span>メーカー</span><select id="fmaker"></select></label>
        <label class="f"><span>商品分野</span><select id="fproduct"></select></label>
        <label class="f"><span>地域</span><select id="fregion"></select></label>
        <label class="f"><span>期間</span><select id="fdays">
          <option value="0">すべて</option><option value="1">24時間</option>
          <option value="3">3日</option><option value="7" selected>7日</option>
          <option value="30">30日</option><option value="90">90日</option></select></label>
        <label class="f"><span>確認状態</span><select id="fstatus">
          <option value="">すべて</option><option value="new">未確認</option>
          <option value="keep">採用</option><option value="pending">保留</option>
          <option value="reject">不採用</option></select></label>
        <label class="f"><span>一次情報</span><select id="fprimary">
          <option value="">すべて</option><option value="primary">一次情報</option>
          <option value="secondary_linked">二次(一次リンクあり)</option>
          <option value="primary_unverified">一次情報未確認</option></select></label>
        <label class="f"><span>最低優先度</span><input type="number" id="fscore" value="0" min="0" max="100"></label>
        <label class="f"><span>並び順</span><select id="fsort">
          <option value="score">優先度順</option><option value="new">新着順</option>
          <option value="changed">更新順</option><option value="published">公開日順</option></select></label>
        <label class="f"><span>&nbsp;</span><button class="btn" id="btnSearch" style="width:100%">検索</button></label>
      </div>
      <div class="row" style="margin-top:6px">
        <label class="chk" style="margin:0"><input type="checkbox" id="fchanged"> 差分が発生したものだけ</label>
        <span style="flex:1"></span>
        <button class="btn ghost sm" data-export="csv">CSV出力</button>
        <button class="btn ghost sm" data-export="json">JSON出力</button>
        <button class="btn ghost sm" data-export="md">日報(Markdown)</button>
      </div>
    </div>
    <div class="panel">
      <div class="spread"><h2 style="margin:0">検索結果</h2><span class="muted small" id="docCount"></span></div>
      <div id="docList" style="margin-top:8px"></div>
      <div class="row" style="margin-top:10px;justify-content:center">
        <button class="btn ghost sm" id="btnPrev">前へ</button>
        <span class="muted small" id="pageInfo"></span>
        <button class="btn ghost sm" id="btnNext">次へ</button>
      </div>
    </div>
  </section>

  <!-- 情報源 -->
  <section id="tab-sources" hidden>
    <div class="panel">
      <div class="spread">
        <h2 style="margin:0">監視対象の登録・編集・停止</h2>
        <div class="row">
          <button class="btn ghost sm" id="btnSeed">初期リストを追加</button>
          <button class="btn" id="btnNewSource">新規登録</button>
        </div>
      </div>
      <div class="notice warn" style="margin-top:10px">
        情報源は <b>URL確認済</b> と <b>利用規約確認済</b> の両方にチェックが入るまで収集されません。
        匿名掲示板・まとめサイト・個人ブログ・出典不明のSNSは正本情報源として登録できません。
      </div>
      <div id="sourceList"></div>
    </div>
  </section>

  <!-- 実行ログ -->
  <section id="tab-runs" hidden>
    <div class="panel"><h2>収集実行の履歴</h2><div id="runList"></div></div>
    <div class="panel"><h2>取得ログ（直近200件）</h2><div id="fetchLogList"></div></div>
  </section>

  <!-- 監査 -->
  <section id="tab-audit" hidden>
    <div class="panel"><h2>監査ログ</h2><div id="auditList"></div></div>
  </section>

  <!-- 設定 -->
  <section id="tab-settings" hidden>
    <div class="panel">
      <h2>収集ポリシー</h2>
      <div class="split">
        <div>
          <label class="f"><span>担当者名（監査ログに記録されます）</span><input type="text" id="s_operator"></label>
          <label class="f"><span>連絡先（User-Agent に記載。収集先が問い合わせできるようにします）</span>
            <input type="text" id="s_contact" placeholder="例: 営業技術部 info@example.co.jp"></label>
          <label class="f"><span>同一ホストへの最小アクセス間隔（秒）</span>
            <input type="number" id="s_min_interval_sec" min="1" max="600"></label>
          <label class="f"><span>1情報源あたりの最大取得ページ数</span>
            <input type="number" id="s_max_pages_per_source" min="1" max="100"></label>
          <label class="chk"><input type="checkbox" id="s_respect_robots">
            <span>robots.txt を尊重する（<b>既定：有効</b>。無効化は推奨しません）</span></label>
        </div>
        <div>
          <label class="chk"><input type="checkbox" id="s_schedule_enabled">
            <span>毎日自動収集を有効にする（アプリ起動中のみ動作します）</span></label>
          <label class="f"><span>自動収集の実行時刻（HH:MM）</span>
            <input type="text" id="s_schedule_time" placeholder="07:30"></label>
          <label class="f"><span>優先地域（カンマ区切り）</span>
            <input type="text" id="s_priority_regions"></label>
          <div class="notice small" id="scheduleNote"></div>
        </div>
      </div>
    </div>
    <div class="panel">
      <h2>AI要約（派生データ生成）</h2>
      <div class="notice warn">
        AIは<b>収集済み原文の分類・要約のみ</b>を行います。出力の各要点には原文からの逐語引用を必須とし、
        引用が原文に実在するかをアプリ側で機械照合します。照合できない出力は「未検証」として扱い、
        事実としては採用しません。
      </div>
      <div class="split">
        <div>
          <label class="chk"><input type="checkbox" id="s_ai_enabled"><span>AI要約を有効にする</span></label>
          <label class="f"><span>モデルID</span>
            <div class="row"><input type="text" id="s_ai_model" placeholder="例: claude-...">
            <button class="btn ghost sm" id="btnModels">一覧取得</button></div></label>
          <label class="f"><span>推論の深さ (effort)</span><select id="s_ai_effort">
            <option value="">指定しない</option><option value="low">low</option>
            <option value="medium">medium</option><option value="high">high</option>
            <option value="xhigh">xhigh</option><option value="max">max</option></select></label>
          <label class="f"><span>AIに渡す原文の最大文字数</span>
            <input type="number" id="s_ai_max_chars" min="1000" max="200000"></label>
        </div>
        <div>
          <label class="f"><span>APIキー（環境変数 ANTHROPIC_API_KEY が優先されます）</span>
            <input type="password" id="s_api_key" placeholder="未設定"></label>
          <div class="small muted" id="apiKeyState"></div>
          <label class="chk" style="margin-top:10px"><input type="checkbox" id="s_ai_auto_on_collect">
            <span>収集後に高優先度の記事だけ自動で要約する</span></label>
          <label class="f"><span>自動要約する優先度のしきい値</span>
            <input type="number" id="s_ai_auto_min_score" min="0" max="100"></label>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="spread">
        <h2 style="margin:0">保存</h2>
        <button class="btn" id="btnSaveSettings">設定を保存</button>
      </div>
      <div class="small muted" id="pathInfo" style="margin-top:8px"></div>
    </div>
  </section>
</main>

<div class="drawer" id="drawer"><div class="drawer-inner" id="drawerInner"></div></div>
<div class="modal" id="modal"><div class="modal-inner" id="modalInner"></div></div>
<div id="toast"></div>

<script>
(function(){
"use strict";
var TOKEN = new URLSearchParams(location.search).get("t") || "";
var STATE = null, PAGE = {offset:0, limit:25, total:0};
var pollTimer = null;

function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function q(sel){ return document.querySelector(sel); }
function qa(sel){ return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function toast(msg, ms){ var t=q("#toast"); t.textContent=msg; t.style.display="block";
  clearTimeout(t._h); t._h=setTimeout(function(){t.style.display="none";}, ms||3200); }

function api(path, opts){
  opts = opts || {};
  var headers = {"X-App-Token": TOKEN};
  if(opts.body){ headers["Content-Type"]="application/json"; }
  return fetch(path, {method: opts.method||"GET", headers: headers,
      body: opts.body?JSON.stringify(opts.body):undefined})
    .then(function(r){ return r.json().then(function(j){
        if(!r.ok){ throw new Error(j.error || ("HTTP "+r.status)); } return j; }); });
}

function jstOf(iso){
  if(!iso) return "—";
  var d = new Date(iso);
  if(isNaN(d.getTime())) return String(iso);
  var p = function(n){ return String(n).padStart(2,"0"); };
  return d.getFullYear()+"/"+p(d.getMonth()+1)+"/"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes());
}
function scoreClass(n){ return n>=75?"score hi":(n>=50?"score mid":"score"); }
function tags(list, cls){ return (list||[]).map(function(x){
  return '<span class="tag '+(cls||"")+'">'+esc(x)+'</span>'; }).join(""); }

/* ---------- タブ（#タブ名 でブックマークできる） ---------- */
var TABS = ["dash","docs","sources","runs","audit","settings"];
function showTab(name){
  /* #doc-123 の形なら記事一覧を開いたうえで該当記事の詳細を開く（社内共有リンク用） */
  var docMatch = /^doc-(\d+)$/.exec(name || "");
  if(docMatch){
    showTab("docs");
    openDoc(docMatch[1]);
    return;
  }
  if(TABS.indexOf(name) < 0) name = "dash";
  qa("nav button").forEach(function(x){ x.classList.toggle("active", x.dataset.tab===name); });
  TABS.forEach(function(t){ q("#tab-"+t).hidden = (t !== name); });
  if(name==="dash") loadDash();
  if(name==="docs") loadDocs(true);
  if(name==="sources") loadSources();
  if(name==="runs") loadRuns();
  if(name==="audit") loadAudit();
}
qa("nav button").forEach(function(b){
  b.addEventListener("click", function(){
    if(location.hash !== "#"+b.dataset.tab){ location.hash = b.dataset.tab; }
    else { showTab(b.dataset.tab); }
  });
});
window.addEventListener("hashchange", function(){
  showTab((location.hash||"").replace("#","")); });

/* ---------- 起動 ---------- */
function boot(){
  api("/api/state").then(function(s){
    STATE = s;
    q("#verline").textContent = "v"+s.app.version+" / 分類エンジン "+s.app.classifier_version;
    fillSelect("#fdomain", [["", "すべて"],["construction","建築案件"],["maker","メーカー情報"]]);
    fillSelect("#fcategory", [["", "すべて"]].concat(
      s.vocab.project_categories.concat(s.vocab.maker_categories).map(function(x){return [x,x];})));
    fillSelect("#fmaker", [["", "すべて"]].concat(s.vocab.makers.map(function(x){return [x,x];})));
    fillSelect("#fproduct", [["", "すべて"]].concat(s.vocab.products.map(function(x){return [x,x];})));
    fillSelect("#fregion", [["", "すべて"]].concat(s.vocab.regions.map(function(x){return [x,x];})));
    applySettings(s);
    showTab((location.hash || "").replace("#", "") || "dash");
    pollState();
  }).catch(function(e){ toast("初期化に失敗しました: "+e.message, 8000); });
}
function fillSelect(sel, pairs){
  var el = q(sel); if(!el) return;
  el.innerHTML = pairs.map(function(p){
    return '<option value="'+esc(p[0])+'">'+esc(p[1])+'</option>'; }).join("");
}
function pollState(){
  clearTimeout(pollTimer);
  pollTimer = setTimeout(function(){
    api("/api/state").then(function(s){
      STATE = s;
      var running = s.collect && s.collect.running;
      q("#btnCollect").disabled = !!running;
      q("#btnCollect").textContent = running ? "収集中…" : "収集を実行";
      q("#scheduleNote").textContent = s.next_scheduled_run
        ? ("次回の自動収集: " + s.next_scheduled_run)
        : "自動収集は無効です。OSのタスクスケジューラから `collect` を呼ぶ運用も可能です。";
      pollState();
    }).catch(function(){ pollState(); });
  }, 4000);
}

/* ---------- ダッシュボード ---------- */
function loadDash(){
  var days = q("#dashDays").value;
  api("/api/dashboard?days="+encodeURIComponent(days)).then(function(d){
    var c = d.counts;
    q("#kpis").innerHTML = [
      ["新規取得", c["new"]], ["差分更新", c.changed], ["未確認", c.unreviewed],
      ["一次情報未確認", c.primary_unverified], ["保存文書 合計", c.documents],
      ["稼働中の情報源", c.sources_enabled + " / " + c.sources_total]
    ].map(function(k){
      return '<div class="kpi"><div class="n">'+esc(k[1])+'</div><div class="l">'+esc(k[0])+'</div></div>';
    }).join("");
    q("#byCategory").innerHTML = barList(d.by_category);
    q("#byMakerRegion").innerHTML =
      '<div class="small muted" style="margin-bottom:4px">メーカー</div>' + barList(d.by_maker) +
      '<div class="small muted" style="margin:10px 0 4px">地域</div>' + barList(d.by_region);
    q("#dashTop").innerHTML = docTable(d.top);
    bindDocRows();
  }).catch(function(e){ toast(e.message, 6000); });
}
function barList(pairs){
  if(!pairs || !pairs.length) return '<div class="muted small">該当なし</div>';
  var max = pairs[0][1] || 1;
  return '<table>' + pairs.map(function(p){
    return '<tr><td style="width:44%">'+esc(p[0])+'</td>'+
      '<td><div class="bar"><i style="width:'+Math.round(p[1]/max*100)+'%"></i></div></td>'+
      '<td style="width:44px;text-align:right">'+esc(p[1])+'</td></tr>'; }).join("") + '</table>';
}

/* ---------- 記事一覧 ---------- */
function docFilters(){
  return {
    q: q("#fq").value.trim(), domain: q("#fdomain").value, category: q("#fcategory").value,
    maker: q("#fmaker").value, product: q("#fproduct").value, region: q("#fregion").value,
    days: q("#fdays").value, status: q("#fstatus").value, primary: q("#fprimary").value,
    min_score: q("#fscore").value, sort: q("#fsort").value,
    changed_only: q("#fchanged").checked ? "1" : ""
  };
}
function loadDocs(reset){
  if(reset) PAGE.offset = 0;
  var f = docFilters();
  f.limit = PAGE.limit; f.offset = PAGE.offset;
  var qs = Object.keys(f).filter(function(k){ return f[k] !== "" && f[k] != null; })
    .map(function(k){ return encodeURIComponent(k)+"="+encodeURIComponent(f[k]); }).join("&");
  api("/api/documents?"+qs).then(function(r){
    PAGE.total = r.total;
    q("#docCount").textContent = r.total + " 件";
    q("#docList").innerHTML = docTable(r.items);
    q("#pageInfo").textContent = (r.total ? (PAGE.offset+1) : 0) + "–" +
      Math.min(PAGE.offset+PAGE.limit, r.total) + " / " + r.total;
    bindDocRows();
  }).catch(function(e){ toast(e.message, 6000); });
}
function docTable(items){
  if(!items || !items.length) return '<div class="muted small">該当する記事がありません。</div>';
  return '<table><thead><tr><th>優先</th><th>タイトル / 情報元</th><th>分類</th>'+
    '<th>公開日</th><th>取得</th><th>状態</th></tr></thead><tbody>' +
    items.map(function(d){
      var pri = d.primary_source_status === "primary" ? "ok" :
                (d.primary_source_status === "primary_unverified" ? "warn" : "plain");
      var ai = d.ai_grounding === "verified" ? '<span class="tag ok">AI要約(検証済)</span>' :
               (d.ai_grounding === "failed" ? '<span class="tag bad">AI要約(未検証)</span>' : "");
      return '<tr class="clickable" data-id="'+d.id+'">'+
        '<td><span class="'+scoreClass(d.priority_score)+'">'+d.priority_score+'</span></td>'+
        '<td><div style="font-weight:600">'+esc(d.title||"(無題)")+'</div>'+
        '<div class="small muted">'+esc(d.source_name||"(情報源未登録)")+
        (d.source_tier?(' / ティア'+d.source_tier):"")+'</div>'+
        '<div class="small mono muted">'+esc(d.url)+'</div></td>'+
        '<td>'+tags(d.categories)+tags(d.makers,"ok")+tags(d.regions,"plain")+'</td>'+
        '<td class="small">'+esc(d.published_at?jstOf(d.published_at):"不明")+'</td>'+
        '<td class="small">'+esc(jstOf(d.first_seen_at))+
        (d.current_version>1?('<br><span class="tag warn">v'+d.current_version+' 差分あり</span>'):"")+'</td>'+
        '<td class="small"><span class="tag '+pri+'">'+esc(d.primary_source_label)+'</span>'+
        '<span class="tag plain">'+esc(reviewLabel(d.review_status))+'</span>'+ai+'</td></tr>';
    }).join("") + '</tbody></table>';
}
function reviewLabel(s){ return {"new":"未確認","keep":"採用","reject":"不採用","pending":"保留"}[s]||s; }
function bindDocRows(){
  qa("tr.clickable[data-id]").forEach(function(tr){
    tr.addEventListener("click", function(){ openDoc(tr.dataset.id); });
  });
}
q("#btnSearch").addEventListener("click", function(){ loadDocs(true); });
q("#fq").addEventListener("keydown", function(e){ if(e.key==="Enter") loadDocs(true); });
q("#btnPrev").addEventListener("click", function(){
  PAGE.offset = Math.max(0, PAGE.offset - PAGE.limit); loadDocs(); });
q("#btnNext").addEventListener("click", function(){
  if(PAGE.offset + PAGE.limit < PAGE.total){ PAGE.offset += PAGE.limit; loadDocs(); } });
qa("[data-export]").forEach(function(b){
  b.addEventListener("click", function(){
    var f = docFilters(); f.format = b.dataset.export; f.t = TOKEN;
    var qs = Object.keys(f).filter(function(k){ return f[k] !== "" && f[k] != null; })
      .map(function(k){ return encodeURIComponent(k)+"="+encodeURIComponent(f[k]); }).join("&");
    window.location = "/api/export?"+qs;
  });
});

/* ---------- 記事詳細 ---------- */
function openDoc(id){
  api("/api/documents/"+id).then(function(d){ renderDoc(d); });
}
function renderDoc(d){
  var src = d.source || {};
  var h = [];
  h.push('<div class="spread"><h2 style="margin:0;font-size:16px;color:var(--ink)">'+
    esc(d.title||"(無題)")+'</h2><div class="row">'+
    '<button class="btn ghost sm" id="copyLink" title="この記事を開くリンクをコピーします">共有リンク</button>'+
    '<button class="btn ghost sm" id="closeDrawer">閉じる</button></div></div>');
  h.push('<div class="row" style="margin:8px 0 14px">'+
    '<span class="'+scoreClass(d.priority_score)+'">優先度 '+d.priority_score+'</span>'+
    tags(d.categories)+tags(d.makers,"ok")+tags(d.products)+tags(d.regions,"plain")+'</div>');

  h.push('<div class="panel"><h2>エビデンス（正本）</h2><dl class="kv">'+
    '<dt>情報元URL</dt><dd><a href="'+esc(d.url)+'" target="_blank" rel="noreferrer noopener" class="mono">'+esc(d.url)+'</a></dd>'+
    '<dt>情報源</dt><dd>'+esc(src.name||"(未登録)")+(src.tier?(" / ティア"+src.tier):"")+'</dd>'+
    '<dt>一次情報判定</dt><dd>'+esc(d.primary_source_label)+
      (d.primary_source_url?(' — <a href="'+esc(d.primary_source_url)+'" target="_blank" rel="noreferrer noopener" class="mono">'+esc(d.primary_source_url)+'</a>'):"")+'</dd>'+
    '<dt>公開日</dt><dd>'+esc(d.published_at?jstOf(d.published_at):"不明")+
      (d.published_at_raw?(' <span class="muted small">(原文表記: '+esc(d.published_at_raw)+' / 出所: '+esc(d.published_at_source)+')</span>'):"")+'</dd>'+
    '<dt>初回取得日時</dt><dd>'+esc(jstOf(d.first_seen_at))+'</dd>'+
    '<dt>最終取得日時</dt><dd>'+esc(jstOf(d.last_seen_at))+'</dd>'+
    '<dt>最終変更日時</dt><dd>'+esc(d.last_changed_at?jstOf(d.last_changed_at):"—")+'</dd>'+
    '<dt>本文SHA-256</dt><dd class="mono">'+esc(d.content_sha256)+'</dd>'+
    '<dt>備考</dt><dd>'+esc(d.evidence_note||"—")+'</dd>'+
    '</dl>'+
    (d.has_raw_html?('<div style="margin-top:10px"><a class="btn ghost sm" href="/api/documents/'+d.id+'/raw?t='+encodeURIComponent(TOKEN)+'" target="_blank">保存済みの原文HTMLを表示</a></div>'):"")+
    '</div>');

  h.push('<div class="panel"><div class="spread"><h2 style="margin:0">確認状態</h2>'+
    '<div class="row">'+
    ["keep","pending","reject","new"].map(function(s){
      return '<button class="btn '+(d.review_status===s?"":"ghost")+' sm" data-review="'+s+'">'+
        reviewLabel(s)+'</button>'; }).join("")+
    '</div></div></div>');

  h.push('<div class="panel"><h2>原文（正本）</h2><pre class="raw">'+esc(d.raw_text||"(本文なし)")+'</pre></div>');

  h.push('<div class="panel"><h2>差分履歴（'+d.versions.length+' 版）</h2>'+
    d.versions.map(function(v){
      return '<div style="margin-bottom:12px"><div class="row">'+
        '<b>v'+v.version_no+'</b><span class="muted small">'+esc(jstOf(v.captured_at))+'</span>'+
        '<span class="tag ok">+'+v.added_lines+'</span><span class="tag bad">-'+v.removed_lines+'</span>'+
        tags(v.change_kinds,"warn")+'</div>'+
        (v.diff_unified?('<pre class="diff">'+diffHtml(v.diff_unified)+'</pre>'):
          '<div class="muted small">初回取得（差分なし）</div>')+'</div>';
    }).join("")+'</div>');

  h.push('<div class="panel"><h2>ルールベース分類（決定論的・再現可能）</h2>'+
    '<div class="small muted">エンジン: rule / '+esc(STATE.app.classifier_version)+'</div>'+
    '<pre class="raw" style="max-height:220px">'+esc(JSON.stringify(d.matched_terms, null, 2))+'</pre></div>');

  h.push('<div class="panel"><div class="spread"><h2 style="margin:0">AI要約（派生データ）</h2>'+
    '<button class="btn ghost sm" id="btnAi">この記事をAIで要約</button></div>'+
    '<div class="small muted" style="margin-bottom:8px">AI要約は正本ではありません。'+
    '各要点は原文からの逐語引用で機械照合しています。</div>'+
    (d.ai.length ? d.ai.map(aiBlock).join("") : '<div class="muted small">AI要約はまだありません。</div>')+
    '</div>');

  q("#drawerInner").innerHTML = h.join("");
  q("#drawer").classList.add("open");
  q("#closeDrawer").addEventListener("click", closeDrawer);
  q("#copyLink").addEventListener("click", function(){
    var link = location.origin + location.pathname + "#doc-" + d.id;
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(link).then(function(){ toast("共有リンクをコピーしました"); },
        function(){ toast(link, 9000); });
    } else { toast(link, 9000); }
  });
  qa("[data-review]").forEach(function(b){
    b.addEventListener("click", function(){
      api("/api/documents/"+d.id+"/review", {method:"POST", body:{status:b.dataset.review}})
        .then(function(){ toast("確認状態を更新しました"); openDoc(d.id); loadDocs(); })
        .catch(function(e){ toast(e.message, 6000); });
    });
  });
  q("#btnAi").addEventListener("click", function(){
    var btn = this; btn.disabled = true; btn.textContent = "要約中…";
    api("/api/documents/"+d.id+"/ai", {method:"POST", body:{}}).then(function(r){
      if(r.ok){ toast(r.skipped ? r.message : ("AI要約を作成しました（根拠照合: "+r.grounding_status+"）")); }
      else { toast("AI要約に失敗: "+(r.error||"不明"), 7000); }
      openDoc(d.id);
    }).catch(function(e){ toast(e.message, 7000); btn.disabled=false; btn.textContent="この記事をAIで要約"; });
  });
}
function aiBlock(a){
  var badge = a.grounding_status==="verified" ? '<span class="tag ok">根拠照合済</span>' :
    (a.grounding_status==="failed" ? '<span class="tag bad">未検証（採用しないでください）</span>' :
     '<span class="tag warn">未検証</span>');
  var body = '<div class="derived"><h4>AI要約（派生データ・正本ではありません）</h4>'+
    '<div class="row small muted"><span>'+esc(jstOf(a.created_at))+'</span>'+
    '<span>モデル: '+esc(a.model||"—")+'</span><span>版: v'+a.version_no+'</span>'+
    '<span>prompt: '+esc(a.prompt_version)+'</span>'+badge+'</div>';
  if(a.error){ body += '<div class="notice bad small" style="margin-top:8px">'+esc(a.error)+'</div>'; }
  if(a.insufficient_evidence){ body += '<div class="notice warn small" style="margin-top:8px">'+
    'AIは「原文からは判断できない」と回答しました。</div>'; }
  if(a.summary){ body += '<p style="margin:8px 0">'+esc(a.summary)+'</p>'; }
  if(a.key_points && a.key_points.length){
    body += '<ul style="margin:6px 0;padding-left:18px">'+a.key_points.map(function(k){
      return '<li>'+esc(k.point)+'<div class="small muted" style="margin:2px 0 6px">'+
        '原文引用: 「'+esc(k.quote)+'」</div></li>'; }).join("")+'</ul>';
  }
  if(a.grounding_failed && a.grounding_failed.length){
    body += '<div class="notice bad small">原文に存在しない引用が '+a.grounding_failed.length+
      ' 件ありました。この要約は事実として採用しないでください。<br>'+
      a.grounding_failed.map(function(k){ return "・"+esc(k.point)+" / 「"+esc(k.quote)+"」"; }).join("<br>")+
      '</div>';
  }
  if(a.uncertainty_notes){ body += '<div class="small muted">確認が必要な点: '+esc(a.uncertainty_notes)+'</div>'; }
  if(a.suggested_categories && a.suggested_categories.length){
    body += '<div style="margin-top:6px" class="small">分類候補（確定ではありません）: '+tags(a.suggested_categories,"plain")+'</div>';
  }
  return body + '</div>';
}
function diffHtml(text){
  return text.split("\n").map(function(line){
    var cls = line.charAt(0)==="+" ? "add" : (line.charAt(0)==="-" ? "del" :
      (line.charAt(0)==="@" ? "hd" : ""));
    return '<span class="'+cls+'">'+esc(line)+'</span>'; }).join("\n");
}
function closeDrawer(){ q("#drawer").classList.remove("open"); }
q("#drawer").addEventListener("click", function(e){ if(e.target.id==="drawer") closeDrawer(); });

/* ---------- 情報源 ---------- */
function loadSources(){
  api("/api/sources").then(function(r){
    q("#sourceList").innerHTML = r.items.length ? ('<table><thead><tr>'+
      '<th>状態</th><th>情報源ID / 対象名</th><th>メーカー</th><th>ティア</th><th>種別</th>'+
      '<th>URL</th><th>最終取得</th><th></th></tr></thead><tbody>'+
      r.items.map(function(s){
        var state = s.enabled ? '<span class="tag ok">稼働</span>' : '<span class="tag plain">停止</span>';
        if(!s.url) state += '<span class="tag warn">URL未登録</span>';
        else if(!s.url_verified) state += '<span class="tag warn">URL未確認</span>';
        if(!s.terms_confirmed) state += '<span class="tag warn">規約未確認</span>';
        if(s.last_error) state += '<span class="tag bad">エラー</span>';
        return '<tr><td>'+state+'</td>'+
          '<td><div class="small mono muted">'+esc(s.source_key)+'</div>'+
          '<div style="font-weight:600">'+esc(s.name)+'</div>'+
          (s.note?('<div class="small muted">'+esc(s.note)+'</div>'):"")+
          (s.last_error?('<div class="small" style="color:var(--bad)">'+esc(s.last_error)+'</div>'):"")+'</td>'+
          '<td class="small">'+esc(s.maker||"—")+'</td>'+
          '<td class="small">'+esc(s.tier)+'<div class="muted" style="font-size:11px">'+esc(s.tier_label)+'</div></td>'+
          '<td class="small">'+esc(s.source_type)+'</td>'+
          '<td class="small mono">'+esc(s.url||"—")+'</td>'+
          '<td class="small">'+esc(s.last_fetch_at?jstOf(s.last_fetch_at):"—")+
          '<div class="muted" style="font-size:11px">'+esc(s.last_status||"")+'</div></td>'+
          '<td class="small"><button class="btn ghost sm" data-edit="'+s.id+'">編集</button> '+
          '<button class="btn ghost sm" data-robots="'+s.id+'">robots確認</button> '+
          '<button class="btn ghost sm" data-run="'+s.id+'">単独収集</button></td></tr>';
      }).join("")+'</tbody></table>') : '<div class="muted small">情報源が登録されていません。</div>';
    window.__sources = r.items;
    qa("[data-edit]").forEach(function(b){ b.addEventListener("click", function(){
      editSource(r.items.filter(function(s){ return String(s.id)===b.dataset.edit; })[0]); }); });
    qa("[data-robots]").forEach(function(b){ b.addEventListener("click", function(){
      b.disabled = true;
      api("/api/sources/"+b.dataset.robots+"/robots", {method:"POST", body:{}})
        .then(function(r2){ toast(r2.decision + (r2.crawl_delay?(" / Crawl-delay: "+r2.crawl_delay+"秒"):""), 9000); })
        .catch(function(e){ toast(e.message, 7000); })
        .then(function(){ b.disabled = false; }); }); });
    qa("[data-run]").forEach(function(b){ b.addEventListener("click", function(){
      api("/api/collect", {method:"POST", body:{source_ids:[parseInt(b.dataset.run,10)]}})
        .then(function(r2){ toast(r2.ok ? "この情報源の収集を開始しました" : r2.error, 5000); })
        .catch(function(e){ toast(e.message, 7000); }); }); });
  }).catch(function(e){ toast(e.message, 6000); });
}
q("#btnSeed").addEventListener("click", function(){
  api("/api/sources/seed", {method:"POST", body:{}}).then(function(r){
    toast(r.inserted + " 件の監視対象候補を追加しました（全て停止状態です）"); loadSources(); });
});
q("#btnNewSource").addEventListener("click", function(){ editSource(null); });

function editSource(s){
  s = s || {tier:1, source_type:"html_list", domain:"construction", min_interval_sec:5,
            max_pages:12, crawl_interval_min:1440};
  var tierOpts = Object.keys(STATE.vocab.tiers).map(function(k){
    return '<option value="'+k+'"'+(String(s.tier)===k?" selected":"")+'>'+k+": "+
      esc(STATE.vocab.tiers[k])+'</option>'; }).join("");
  q("#modalInner").innerHTML =
    '<div class="spread"><h2 style="margin:0;color:var(--ink)">情報源の'+(s.id?"編集":"新規登録")+'</h2>'+
    '<button class="btn ghost sm" id="closeModal">閉じる</button></div>'+
    '<div class="split" style="margin-top:12px"><div>'+
    '<label class="f"><span>情報源ID（英数字・重複不可）</span><input type="text" id="m_key" value="'+esc(s.source_key||"")+'"'+(s.id?" disabled":"")+'></label>'+
    '<label class="f"><span>対象名 *</span><input type="text" id="m_name" value="'+esc(s.name||"")+'"></label>'+
    '<label class="f"><span>メーカー</span><input type="text" id="m_maker" value="'+esc(s.maker||"")+'"></label>'+
    '<label class="f"><span>領域</span><select id="m_domain">'+
      ['construction','maker','both'].map(function(v){ return '<option value="'+v+'"'+(s.domain===v?" selected":"")+'>'+
        ({construction:"建築案件",maker:"メーカー情報",both:"両方"})[v]+'</option>'; }).join("")+'</select></label>'+
    '<label class="f"><span>監視URL</span><input type="text" id="m_url" value="'+esc(s.url||"")+'" placeholder="https://..."></label>'+
    '<label class="f"><span>種別</span><select id="m_type">'+
      [['auto','自動判定'],['rss','RSS/Atom'],['html','単一ページ（差分監視）'],['html_list','一覧ページ（リンク追跡）']]
      .map(function(v){ return '<option value="'+v[0]+'"'+(s.source_type===v[0]?" selected":"")+'>'+v[1]+'</option>'; }).join("")+
      '</select></label>'+
    '<label class="f"><span>情報源ティア（優先順位）</span><select id="m_tier">'+tierOpts+'</select></label>'+
    '</div><div>'+
    '<label class="f"><span>対象地域</span><input type="text" id="m_region" value="'+esc(s.region||"")+'" placeholder="例: 東京都"></label>'+
    '<label class="f"><span>追跡リンクの正規表現（空欄なら新着系キーワードで自動判定）</span><input type="text" id="m_filter" value="'+esc(s.link_filter||"")+'"></label>'+
    '<label class="f"><span>1回あたり最大取得ページ数</span><input type="number" id="m_maxpages" value="'+esc(s.max_pages||12)+'" min="1" max="100"></label>'+
    '<label class="f"><span>このホストへの最小アクセス間隔（秒）</span><input type="number" id="m_interval" value="'+esc(s.min_interval_sec||5)+'" min="1" max="600"></label>'+
    '<label class="f"><span>利用規約のURL</span><input type="text" id="m_termsurl" value="'+esc(s.terms_url||"")+'"></label>'+
    '<label class="f"><span>備考</span><textarea id="m_note">'+esc(s.note||"")+'</textarea></label>'+
    '</div></div>'+
    '<div style="border-top:1px solid var(--line);padding-top:12px;margin-top:6px">'+
    '<label class="chk"><input type="checkbox" id="m_urlok"'+(s.url_verified?" checked":"")+'>'+
    '<span><b>URL確認済</b> — 公式サイトの正しいURLであることを確認しました</span></label>'+
    '<label class="chk"><input type="checkbox" id="m_termsok"'+(s.terms_confirmed?" checked":"")+'>'+
    '<span><b>利用規約確認済</b> — 収集が利用規約に反しないこと、会員限定領域を含まないことを確認しました</span></label>'+
    '<label class="chk"><input type="checkbox" id="m_enabled"'+(s.enabled?" checked":"")+'>'+
    '<span><b>収集を有効にする</b>（上記2点の確認が必要です）</span></label>'+
    '</div>'+
    '<div class="row" style="margin-top:12px">'+
    '<button class="btn" id="m_save">保存</button>'+
    (s.id?'<button class="btn danger sm" id="m_delete">削除</button>':"")+
    '</div>';
  q("#modal").classList.add("open");
  q("#closeModal").addEventListener("click", function(){ q("#modal").classList.remove("open"); });
  q("#m_save").addEventListener("click", function(){
    var body = {
      id: s.id, source_key: q("#m_key").value.trim(), name: q("#m_name").value.trim(),
      maker: q("#m_maker").value.trim(), domain: q("#m_domain").value,
      url: q("#m_url").value.trim(), source_type: q("#m_type").value,
      tier: parseInt(q("#m_tier").value,10), region: q("#m_region").value.trim(),
      link_filter: q("#m_filter").value.trim(), max_pages: parseInt(q("#m_maxpages").value,10),
      min_interval_sec: parseInt(q("#m_interval").value,10),
      terms_url: q("#m_termsurl").value.trim(), note: q("#m_note").value,
      url_verified: q("#m_urlok").checked, terms_confirmed: q("#m_termsok").checked,
      enabled: q("#m_enabled").checked
    };
    api("/api/sources", {method:"POST", body:body}).then(function(){
      toast("保存しました"); q("#modal").classList.remove("open"); loadSources();
    }).catch(function(e){ toast(e.message, 7000); });
  });
  if(s.id){
    q("#m_delete").addEventListener("click", function(){
      if(!confirm("この情報源を削除します。収集済みの文書は残ります。よろしいですか？")) return;
      api("/api/sources/"+s.id, {method:"DELETE"}).then(function(){
        toast("削除しました"); q("#modal").classList.remove("open"); loadSources(); })
        .catch(function(e){ toast(e.message, 7000); });
    });
  }
}
q("#modal").addEventListener("click", function(e){
  if(e.target.id==="modal") q("#modal").classList.remove("open"); });

/* ---------- 実行ログ / 監査 ---------- */
function loadRuns(){
  api("/api/runs").then(function(r){
    q("#runList").innerHTML = r.items.length ? ('<table><thead><tr><th>実行キー</th><th>種別</th>'+
      '<th>開始</th><th>終了</th><th>情報源</th><th>新規</th><th>更新</th><th>変化なし</th>'+
      '<th>重複候補</th><th>メモ</th></tr></thead><tbody>'+
      r.items.map(function(x){
        return '<tr><td class="mono small">'+esc(x.run_key)+'</td><td class="small">'+esc(x.mode)+'</td>'+
          '<td class="small">'+esc(jstOf(x.started_at))+'</td>'+
          '<td class="small">'+esc(x.finished_at?jstOf(x.finished_at):"実行中")+'</td>'+
          '<td class="small">OK '+x.sources_ok+' / skip '+x.sources_skipped+' / err '+x.sources_error+
          ' / 計 '+x.sources_total+'</td>'+
          '<td>'+x.docs_new+'</td><td>'+x.docs_updated+'</td><td>'+x.docs_unchanged+'</td>'+
          '<td>'+x.docs_duplicate+'</td>'+
          '<td class="small muted" style="max-width:340px;white-space:pre-wrap">'+esc(x.note||"")+'</td></tr>';
      }).join("")+'</tbody></table>') : '<div class="muted small">実行履歴はまだありません。</div>';
  });
  api("/api/fetch-logs").then(function(r){
    q("#fetchLogList").innerHTML = r.items.length ? ('<table><thead><tr><th>日時</th><th>URL</th>'+
      '<th>HTTP</th><th>bytes</th><th>robots判定</th><th>エラー</th></tr></thead><tbody>'+
      r.items.map(function(x){
        return '<tr><td class="small">'+esc(jstOf(x.started_at))+'</td>'+
          '<td class="small mono" style="max-width:330px">'+esc(x.url)+'</td>'+
          '<td class="small">'+esc(x.http_status==null?"—":x.http_status)+'</td>'+
          '<td class="small">'+esc(x.bytes)+'</td>'+
          '<td class="small muted" style="max-width:260px">'+esc(x.robots_decision)+'</td>'+
          '<td class="small" style="color:var(--bad);max-width:260px">'+esc(x.error||"")+'</td></tr>';
      }).join("")+'</tbody></table>') : '<div class="muted small">取得ログはまだありません。</div>';
  });
}
function loadAudit(){
  api("/api/audit").then(function(r){
    q("#auditList").innerHTML = r.items.length ? ('<table><thead><tr><th>日時</th><th>担当</th>'+
      '<th>操作</th><th>対象</th><th>詳細</th></tr></thead><tbody>'+
      r.items.map(function(x){
        return '<tr><td class="small">'+esc(jstOf(x.at))+'</td><td class="small">'+esc(x.actor)+'</td>'+
          '<td class="small"><span class="tag plain">'+esc(x.action)+'</span></td>'+
          '<td class="small">'+esc(x.target_type)+(x.target_id?(" #"+esc(x.target_id)):"")+'</td>'+
          '<td class="small muted" style="max-width:520px;white-space:pre-wrap">'+esc(x.detail)+'</td></tr>';
      }).join("")+'</tbody></table>') : '<div class="muted small">監査ログはまだありません。</div>';
  });
}

/* ---------- 設定 ---------- */
var SETTING_KEYS = ["operator","contact","min_interval_sec","max_pages_per_source",
  "respect_robots","schedule_enabled","schedule_time","priority_regions",
  "ai_enabled","ai_model","ai_effort","ai_max_chars","ai_auto_on_collect","ai_auto_min_score"];
function applySettings(s){
  SETTING_KEYS.forEach(function(k){
    var el = q("#s_"+k); if(!el) return;
    if(el.type === "checkbox"){ el.checked = (s.settings[k] === "1"); }
    else { el.value = s.settings[k] == null ? "" : s.settings[k]; }
  });
  q("#apiKeyState").textContent = s.api_key_present
    ? (s.api_key_from_env ? "APIキー: 環境変数から読み込み済み" : "APIキー: ローカルファイルに保存済み")
    : "APIキー: 未設定";
  q("#pathInfo").textContent = "データ保存先: " + s.app.data_dir + " / DB: " + s.app.db_path;
  q("#scheduleNote").textContent = s.next_scheduled_run
    ? ("次回の自動収集: " + s.next_scheduled_run) : "自動収集は無効です。";
}
q("#btnSaveSettings").addEventListener("click", function(){
  var payload = {settings:{}};
  SETTING_KEYS.forEach(function(k){
    var el = q("#s_"+k); if(!el) return;
    payload.settings[k] = (el.type==="checkbox") ? (el.checked?"1":"0") : el.value;
  });
  var key = q("#s_api_key").value.trim();
  if(key){ payload.api_key = key; }
  api("/api/settings", {method:"POST", body:payload}).then(function(){
    q("#s_api_key").value = "";
    toast("設定を保存しました");
    return api("/api/state");
  }).then(function(s){ STATE = s; applySettings(s); })
    .catch(function(e){ toast(e.message, 7000); });
});
q("#btnModels").addEventListener("click", function(){
  var b = this; b.disabled = true;
  api("/api/models").then(function(r){
    var names = r.items.map(function(m){ return m.id + (m.display_name?(" — "+m.display_name):""); });
    toast("利用可能なモデル: " + names.slice(0,8).join(" / "), 12000);
    var input = q("#s_ai_model");
    var list = document.createElement("datalist"); list.id = "modelList";
    list.innerHTML = r.items.map(function(m){ return '<option value="'+esc(m.id)+'">'; }).join("");
    var old = q("#modelList"); if(old) old.remove();
    document.body.appendChild(list); input.setAttribute("list","modelList");
  }).catch(function(e){ toast("モデル一覧の取得に失敗: "+e.message, 8000); })
    .then(function(){ b.disabled = false; });
});

/* ---------- 収集 ---------- */
q("#btnCollect").addEventListener("click", function(){
  api("/api/collect", {method:"POST", body:{}}).then(function(r){
    if(r.ok){ toast("収集を開始しました。実行ログで進行を確認できます。"); }
    else { toast(r.error, 5000); }
  }).catch(function(e){ toast(e.message, 7000); });
});
q("#btnReloadDash").addEventListener("click", loadDash);
q("#dashDays").addEventListener("change", loadDash);

boot();
})();
</script>
</body>
</html>
'''

# ===========================================================================
# CLI / 起動
# ===========================================================================


def cmd_serve(args) -> int:
    db = Database(DB_PATH)
    if db.one("SELECT COUNT(*) n FROM sources")["n"] == 0:
        inserted = seed_sources(db)
        print(f"初期の監視対象候補を {inserted} 件登録しました（すべて停止状態です）。")

    ctx = AppContext(db)
    ctx.scheduler.start()

    port = args.port or pick_port()
    RequestHandler.ctx = ctx
    server = LocalServer(("127.0.0.1", port), RequestHandler)
    url = f"http://127.0.0.1:{port}/?t={ctx.token}"

    print("=" * 78)
    print(f" {APP_NAME}  v{APP_VERSION}")
    print("=" * 78)
    print(f" 管理画面 : {url}")
    print(f" データ   : {DB_PATH}")
    print(" 停止     : このウィンドウで Ctrl+C")
    print("=" * 78)
    db.audit("app.start", "", "", f"port={port}")

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n停止しました。")
    finally:
        ctx.scheduler.stop()
        server.server_close()
        db.audit("app.stop", "", "", "")
    return 0


def cmd_collect(args) -> int:
    db = Database(DB_PATH)
    collector = Collector(db)
    source_ids = None
    if args.source:
        rows = db.query(
            "SELECT id FROM sources WHERE source_key=? OR id=?",
            (args.source, args.source if str(args.source).isdigit() else -1),
        )
        source_ids = [int(row["id"]) for row in rows]
        if not source_ids:
            print(f"情報源が見つかりません: {args.source}", file=sys.stderr)
            return 2
    result = collector.run(mode="cli", source_ids=source_ids)
    print(json.dumps(
        {k: v for k, v in result.items() if k != "messages"}, ensure_ascii=False, indent=2))
    for message in result.get("messages", [])[-40:]:
        print(f"  - {message}")
    if db.setting_bool("ai_auto_on_collect"):
        print(json.dumps(auto_annotate(db), ensure_ascii=False))
    return 0


def cmd_export(args) -> int:
    db = Database(DB_PATH)
    params = {"days": args.days, "min_score": args.min_score, "sort": "score"}
    if args.maker:
        params["maker"] = args.maker
    if args.category:
        params["category"] = args.category
    filename, _content_type, payload = export_documents(db, params, args.format)
    os.makedirs(EXPORT_DIR, exist_ok=True)
    out_path = args.out or os.path.join(EXPORT_DIR, filename)
    with open(out_path, "wb") as handle:
        handle.write(payload)
    db.audit("export.cli", "", "", out_path)
    print(f"出力しました: {out_path}")
    return 0


def cmd_sources(args) -> int:
    db = Database(DB_PATH)
    if args.seed:
        print(f"{seed_sources(db)} 件を追加しました。")
        return 0
    rows = db.query("SELECT * FROM sources ORDER BY tier, name")
    for row in rows:
        flags = []
        flags.append("稼働" if row["enabled"] else "停止")
        if not row["url"]:
            flags.append("URL未登録")
        elif not row["url_verified"]:
            flags.append("URL未確認")
        if not row["terms_confirmed"]:
            flags.append("規約未確認")
        print(f"[{row['id']:>3}] {row['source_key']:<18} T{row['tier']} "
              f"{row['name']}  ({'/'.join(flags)})  {row['url'] or '-'}")
    print(f"\n合計 {len(rows)} 件")
    return 0


def cmd_selftest(_args) -> int:
    """外部通信をせずに、分類・重複判定・差分・根拠照合の要となる処理を検証する。"""
    failures: list[str] = []

    def check(label: str, condition: bool, detail: str = "") -> None:
        if condition:
            print(f"  OK   {label}")
        else:
            print(f"  NG   {label} {detail}")
            failures.append(label)

    print("1) URL正規化と重複判定")
    a = canonicalize_url("https://Example.com/news/index.html?utm_source=x&b=2&a=1")
    b = canonicalize_url("https://example.com/news/?a=1&b=2")
    check("トラッキングパラメータと index.html を除去して同一視できる", a == b, f"{a} != {b}")
    check("SHA-256の重複キーが一致する", sha256_text(a) == sha256_text(b))

    print("2) 除外情報源の判定")
    check("匿名掲示板を拒否する", is_denied_source("https://hoge.5ch.net/test/") is not None)
    check("個人ブログを拒否する", is_denied_source("https://foo.ameblo.jp/entry") is not None)
    check("メーカー公式は許可する", is_denied_source("https://www.example.co.jp/news/") is None)

    print("3) HTML解析")
    html = ("<html><head><title>製品廃番のお知らせ</title>"
            "<meta property='article:published_time' content='2026-07-01T09:00:00+09:00'>"
            "</head><body><script>var x=1;</script>"
            "<p>弊社製品 VK-200 は 2026年9月30日 をもって廃番とさせていただきます。</p>"
            "<a href='/news/detail.html'>詳細</a></body></html>")
    parsed = parse_html(html, "https://www.example.co.jp/news/")
    check("タイトルを抽出できる", parsed.title == "製品廃番のお知らせ", parsed.title)
    check("scriptを本文から除外する", "var x=1" not in parsed.text, parsed.text[:80])
    check("本文を抽出できる", "廃番" in parsed.text)
    check("公開日をmetaから取得できる", parsed.published_at is not None)
    check("相対リンクを絶対URL化できる",
          any(u == "https://www.example.co.jp/news/detail.html" for u, _ in parsed.links))

    print("4) 日付解釈")
    for text, label in [("2026年8月4日", "和暦なし日本語表記"),
                        ("令和8年8月4日", "令和表記"),
                        ("Mon, 04 Aug 2026 09:00:00 +0900", "RFC822"),
                        ("2026-08-04T09:00:00+09:00", "ISO8601")]:
        parsed_dt, _raw = parse_datetime_any(text)
        check(f"{label} を解釈できる", parsed_dt is not None and parsed_dt.year == 2026, text)

    print("5) RSS解析")
    feed = ("<?xml version='1.0'?><rss version='2.0'><channel>"
            "<item><title>価格改定のお知らせ</title>"
            "<link>https://www.example.co.jp/news/1.html</link>"
            "<pubDate>Mon, 04 Aug 2026 09:00:00 +0900</pubDate>"
            "<description>2026年10月1日出荷分より価格を改定します。</description>"
            "</item></channel></rss>")
    items = parse_feed(feed, "https://www.example.co.jp/")
    check("RSSから1件抽出できる", len(items) == 1)
    if items:
        check("記事URLを取得できる", items[0]["url"].endswith("/news/1.html"))
        check("公開日を取得できる", items[0]["published_at"] is not None)

    print("6) ルールベース分類")
    result = classify(
        "メルコエアテック 換気口 VK-200 廃番および後継品のご案内",
        "東京都内の集合住宅向け差圧式給気口 VK-200 を廃番とし、後継品 VK-300 へ切り替えます。"
        "価格改定は2026年10月1日出荷分から適用します。",
        source_tier=1, published_at=now_utc(),
    )
    check("メーカーを検出する", "メルコエアテック" in result.makers, str(result.makers))
    check("廃番を検出する", "廃番" in result.categories, str(result.categories))
    check("後継品を検出する", "後継品" in result.categories)
    check("価格改定を検出する", "価格改定" in result.categories)
    check("商品分野を検出する", "差圧式給気口" in result.products, str(result.products))
    check("優先地域を検出する", "東京都" in result.regions, str(result.regions))
    check("優先度が高スコアになる", result.priority_score >= 75, str(result.priority_score))

    print("7) 差分検出")
    diff = "\n".join(difflib.unified_diff(
        ["VK-200 は継続販売します。"], ["VK-200 は廃番とし、価格改定を行います。"],
        lineterm="", n=1))
    kinds = detect_change_kinds(diff)
    check("差分から廃番を検出する", "廃番" in kinds, str(kinds))
    check("差分から価格改定を検出する", "価格改定" in kinds)

    print("8) エビデンス・一次情報判定")
    ok, _note, status, _url = evaluate_evidence(
        "https://www.example.co.jp/news/1.html", "本文" * 30, 1, [])
    check("ティア1は一次情報と判定する", ok and status == "primary", status)
    ok2, _n2, status2, _u2 = evaluate_evidence(
        "https://media.example.com/a", "本文" * 30, 4, [])
    check("ティア4でリンクが無ければ一次情報未確認", status2 == "primary_unverified", status2)
    ok3, _n3, status3, url3 = evaluate_evidence(
        "https://media.example.com/a", "本文" * 30, 4,
        [("https://www.mlit.go.jp/report/press/001.html", "国交省発表")])
    check("ティア4でも一次情報リンクがあれば紐付ける",
          status3 == "secondary_linked" and url3.endswith("001.html"), status3)

    print("9) AI出力の根拠照合（grounding）")
    source_text = re.sub(r"\s+", "", normalize_text("VK-200 は 2026年9月30日 をもって廃番とします。")).lower()
    check("原文にある引用は照合成功", _quote_found("2026年9月30日をもって廃番とします", source_text))
    check("原文にない引用は照合失敗", not _quote_found("2027年3月末で生産を終了します", source_text))
    check("短すぎる引用は不採用", not _quote_found("廃番", source_text))

    print("10) 近似重複（SimHash）")
    text_a = "東京都港区で地上30階建てのマンション新築計画。着工は2026年10月を予定。" * 3
    text_b = "東京都港区で地上30階建てのマンション新築計画。着工は2026年10月を予定です。" * 3
    text_c = "群馬県前橋市の物流倉庫が竣工しました。延床面積は約12000平方メートル。" * 3
    text_d = ("【転載】東京都港区で地上30階建てのマンション新築計画。"
              "着工は2026年10月を予定。以上、記事より引用。") * 3
    dist_ab = hamming_hex(simhash64(text_a), simhash64(text_b))
    dist_ac = hamming_hex(simhash64(text_a), simhash64(text_c))
    dist_ad = hamming_hex(simhash64(text_a), simhash64(text_d))
    check("語尾違いの同一情報を近似重複と判定",
          dist_ab <= NEAR_DUPLICATE_MAX_DISTANCE, f"距離={dist_ab}")
    check("転載ページを近似重複と判定", dist_ad <= NEAR_DUPLICATE_MAX_DISTANCE, f"距離={dist_ad}")
    check("別内容は重複と判定しない", dist_ac > NEAR_DUPLICATE_MAX_DISTANCE, f"距離={dist_ac}")

    print("11) データベース一巡（一時DB）")
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        db = Database(os.path.join(tmp, "t.sqlite3"))
        db.execute(
            "INSERT INTO sources(source_key,name,maker,domain,url,source_type,tier,region,"
            "enabled,url_verified,terms_confirmed,created_at,updated_at) "
            "VALUES('t1','テスト','メルコエアテック','maker','https://www.example.co.jp/news/',"
            "'html',1,'東京都',1,1,1,?,?)", (now_iso(), now_iso()))
        source = db.one("SELECT * FROM sources WHERE source_key='t1'")
        collector = Collector.__new__(Collector)
        collector.db = db
        collector.priority_regions = PRIORITY_REGIONS
        collector._cancel = threading.Event()
        stats = CollectStats()
        doc_id, action1 = collector.store_document(
            source=source, url="https://www.example.co.jp/news/1.html",
            title="VK-200 廃番のお知らせ", raw_text="VK-200 を廃番とします。",
            raw_html=b"<html>1</html>", published_at=now_utc(), published_raw="",
            published_source="meta", http_status=200, etag=None, last_modified=None,
            links=[], fetch_log_id=None, stats=stats)
        check("新規保存できる", action1 == "new" and doc_id > 0, action1)
        _id2, action2 = collector.store_document(
            source=source, url="https://www.example.co.jp/news/1.html?utm_source=mail",
            title="VK-200 廃番のお知らせ", raw_text="VK-200 を廃番とします。",
            raw_html=b"<html>1</html>", published_at=now_utc(), published_raw="",
            published_source="meta", http_status=200, etag=None, last_modified=None,
            links=[], fetch_log_id=None, stats=stats)
        check("同一URLは重複登録しない", action2 == "unchanged", action2)
        _id3, action3 = collector.store_document(
            source=source, url="https://www.example.co.jp/news/1.html",
            title="VK-200 廃番のお知らせ",
            raw_text="VK-200 を廃番とします。後継品は VK-300 です。価格改定も行います。",
            raw_html=b"<html>2</html>", published_at=now_utc(), published_raw="",
            published_source="meta", http_status=200, etag=None, last_modified=None,
            links=[], fetch_log_id=None, stats=stats)
        check("本文変化で新しい版を作る", action3 == "updated", action3)
        versions = db.query("SELECT * FROM document_versions WHERE document_id=? ORDER BY version_no",
                            (doc_id,))
        check("版が2つ保存されている", len(versions) == 2, str(len(versions)))
        check("差分に後継品が記録されている",
              "後継品" in json.loads(versions[1]["change_kinds"]),
              versions[1]["change_kinds"])
        detail = document_detail(db, doc_id)
        check("詳細を取得できる", detail is not None and detail["current_version"] == 2)
        found = search_documents(db, {"maker": "メルコエアテック", "days": 0})
        check("メーカーで検索できる", found["total"] == 1, str(found["total"]))
        _fn, _ct, csv_body = export_documents(db, {"days": 0}, "csv")
        check("CSVを出力できる", b"VK-200" in csv_body or "VK-200".encode("utf-8") in csv_body)

    print("12) HTTPヘッダの安全性（日本語の連絡先を設定してもヘッダを壊さない）")
    with tempfile.TemporaryDirectory() as tmp:
        db3 = Database(os.path.join(tmp, "t3.sqlite3"))
        db3.set_setting("contact", "営業技術部 換気課 info@example.co.jp ＴＥＬ03-0000-0000")
        agent = Fetcher(db3).user_agent
        try:
            agent.encode("latin-1")
            encodable = True
        except UnicodeEncodeError:
            encodable = False
        check("User-Agent が latin-1 でエンコードできる", encodable, agent)
        check("連絡先のASCII部分は残る", "info@example.co.jp" in agent, agent)
        db3.set_setting("contact", "営業技術部")
        agent2 = Fetcher(db3).user_agent
        check("連絡先が全て非ASCIIでも既定値で成立する",
              DEFAULT_CONTACT in agent2 and agent2.isascii(), agent2)

    print("13) 情報源バリデーション")
    with tempfile.TemporaryDirectory() as tmp:
        db2 = Database(os.path.join(tmp, "t2.sqlite3"))
        try:
            api_save_source(db2, {"name": "x", "url": "https://foo.ameblo.jp/", "tier": 1})
            check("除外ドメインの登録を拒否する", False, "拒否されませんでした")
        except ApiError:
            check("除外ドメインの登録を拒否する", True)
        try:
            api_save_source(db2, {"name": "y", "url": "https://www.example.co.jp/",
                                  "tier": 1, "enabled": True})
            check("未確認のまま有効化できない", False, "有効化できてしまいました")
        except ApiError:
            check("未確認のまま有効化できない", True)

    print()
    if failures:
        print(f"自己診断: {len(failures)} 件 失敗")
        for item in failures:
            print(f"  - {item}")
        return 1
    print("自己診断: すべて成功しました。")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kanki_intel.py",
        description=f"{APP_NAME} v{APP_VERSION}",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "例:\n"
            "  python3 kanki_intel.py serve\n"
            "  python3 kanki_intel.py collect\n"
            "  python3 kanki_intel.py export --format csv --days 7\n"
            "  python3 kanki_intel.py selftest\n"
        ),
    )
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="管理画面を起動する（既定）")
    serve.add_argument("--port", type=int, default=0, help="ポート番号（既定: 空きポートを自動選択）")
    serve.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    serve.set_defaults(func=cmd_serve)

    collect = sub.add_parser("collect", help="収集を1回だけ実行する（OSのスケジューラ向け）")
    collect.add_argument("--source", help="情報源ID または 数値ID を指定して1件だけ収集")
    collect.set_defaults(func=cmd_collect)

    export = sub.add_parser("export", help="収集結果を書き出す")
    export.add_argument("--format", choices=["csv", "json", "md"], default="csv")
    export.add_argument("--days", type=int, default=7)
    export.add_argument("--min-score", dest="min_score", type=int, default=0)
    export.add_argument("--maker")
    export.add_argument("--category")
    export.add_argument("--out")
    export.set_defaults(func=cmd_export)

    sources = sub.add_parser("sources", help="情報源の一覧表示 / 初期リスト投入")
    sources.add_argument("--seed", action="store_true", help="初期の監視対象候補を登録する")
    sources.set_defaults(func=cmd_sources)

    selftest = sub.add_parser("selftest", help="外部通信なしで内部処理を検証する")
    selftest.set_defaults(func=cmd_selftest)
    return parser


def main(argv: list[str] | None = None) -> int:
    os.makedirs(DATA_DIR, exist_ok=True)
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        args = parser.parse_args((argv or []) + ["serve"])
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
