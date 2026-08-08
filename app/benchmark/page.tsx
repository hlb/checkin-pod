import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import styles from "./benchmark.module.css";

const pageTitle = "Checkin Pod 效能實測｜10,000 人 × 50 個入口";
const pageDescription =
  "10,000 位來賓、50 個並行入口、496.86 req/s、0 次非預期失敗。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"))
    ?.split(",")[0]
    .trim();
  const protocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0].trim()
    ?? (host?.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${protocol}://${host}` : undefined;
  const imageUrl = origin ? `${origin}/og.png` : undefined;

  return {
    title: pageTitle,
    description: pageDescription,
    robots: { index: true, follow: true },
    openGraph: {
      title: "10,000 位來賓，50 個入口，同一份正確名單",
      description: "Checkin Pod 多工作站報到效能與防重複實測。",
      type: "website",
      url: origin ? `${origin}/benchmark` : undefined,
      images: imageUrl ? [{ url: imageUrl, width: 1734, height: 907, alt: "Checkin Pod 萬人多入口效能實測" }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: "10,000 位來賓，50 個入口，同一份正確名單",
      description: "Checkin Pod 多工作站報到效能與防重複實測。",
      images: imageUrl ? [imageUrl] : undefined,
    },
  };
}

const headlineMetrics = [
  { value: "10,000", label: "位來賓完整報到" },
  { value: "50", label: "個入口同時作業" },
  { value: "496.86", unit: "req/s", label: "實測平均吞吐量" },
  { value: "0", label: "非預期失敗" },
];

const organizerOutcomes = [
  {
    number: "01",
    title: "50 個入口同步報到",
    body: "50 個獨立工作站共享同一份即時名單。每個入口使用獨立安全連結，並記錄各自的成功數。",
    proof: "50 / 50 工作站連線成功",
  },
  {
    number: "02",
    title: "50 台同掃，1 台成功",
    body: "50 台工作站同時掃描同一張票。系統記錄 1 次成功，並回報 49 次已報到。",
    proof: "10 / 10 輪競態結果一致",
  },
  {
    number: "03",
    title: "10,000 筆名單完整復原",
    body: "伺服器保存共同活動狀態。工作站可重新載入 10,000 筆名單與完整報到時間。",
    proof: "10,000 / 10,000 完整復原",
  },
];

const latencyRows = [
  { label: "一般回應 p50", value: "95.8 ms", width: "25%" },
  { label: "忙碌時段 p95", value: "135.3 ms", width: "35%" },
  { label: "極端值 p99", value: "162.4 ms", width: "42%" },
  { label: "單次最高", value: "384.8 ms", width: "100%" },
];

const testSteps = [
  { label: "匯入", value: "10,000 人名單", note: "2.64 秒完成" },
  { label: "開站", value: "50 個獨立入口", note: "建立並逐一驗證" },
  { label: "掃描", value: "10,542 次請求", note: "21.22 秒掃描階段" },
  { label: "搶刷", value: "10 張高競爭票", note: "每張由 50 台同掃" },
  { label: "對帳", value: "10,000 筆一致", note: "名單、活動紀錄、工作站、投影" },
];

const verifiedChecks = [
  "10,001 人容量邊界回報 HTTP 413",
  "錯誤工作站憑證回報 HTTP 401",
  "舊工作站憑證回報 HTTP 401",
  "停用入口的掃描請求回報 HTTP 401",
  "同一請求重送保留同一筆成功紀錄",
  "50 / 50 筆未知票券回報 unknown",
  "10,000 筆工作站成功數與活動紀錄一致",
  "投影牆取得 10,000 筆來賓狀態",
];

function Brand() {
  return (
    <span className={styles.brandLockup}>
      <span className={styles.brandMark}>P</span>
      <span>
        <strong>Checkin Pod</strong>
        <small>公開效能實測</small>
      </span>
    </span>
  );
}

export default function BenchmarkPage() {
  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <a className={styles.brand} href="/benchmark" aria-label="Checkin Pod 效能實測首頁">
          <Brand />
        </a>
        <nav className={styles.nav} aria-label="頁面導覽">
          <a href="#organizer">主辦單位重點</a>
          <a href="#results">實測數字</a>
          <a href="#method">測試方式</a>
          <a className={styles.navCta} href="/">進入中控台</a>
        </nav>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span /> 10,000 人 × 50 工作站壓力測試</p>
          <h1>10,000 位來賓，<br />50 個入口同步報到，<br /><em>496.86 req/s。</em></h1>
          <p className={styles.heroLead}>
            本次壓測完成 10,000 人名單匯入、50 個入口同步掃描、10 輪同票競態與完整名單復原。
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primaryAction} href="/checkin-pod-sample-10000.zip" download>
              下載 10,000 人測試包 <span aria-hidden="true">↓</span>
            </a>
            <a className={styles.secondaryAction} href="/projection" target="_blank" rel="noreferrer">
              看公開投影畫面 <span aria-hidden="true">↗</span>
            </a>
          </div>
          <p className={styles.heroNote}>2026-08-08 本機工程壓測 · Node v22.23.1 · macOS arm64</p>
        </div>

        <div className={styles.liveCard} aria-label="壓力測試結果摘要">
          <div className={styles.liveCardHead}>
            <span><i /> STRESS TEST COMPLETE</span>
            <strong>PASS</strong>
          </div>
          <div className={styles.liveTotal}>
            <small>最終報到總數</small>
            <strong>10,000 <span>/ 10,000</span></strong>
            <div className={styles.totalTrack}><i /></div>
          </div>
          <div className={styles.laneMap} aria-hidden="true">
            {Array.from({ length: 50 }, (_, index) => (
              <span key={index} className={index === 7 || index === 31 ? styles.hotLane : undefined} />
            ))}
          </div>
          <div className={styles.raceResult}>
            <div>
              <span>同票 50 台搶刷</span>
              <strong>1 台成功</strong>
            </div>
            <div className={styles.raceSplit} aria-label="1 次成功，49 次重複">
              <i /><span />
            </div>
            <small>49 台回報「已報到」</small>
          </div>
          <div className={styles.liveFoot}>
            <span><strong>21 / 21</strong> 檢查通過</span>
            <span><strong>0</strong> 非預期失敗</span>
          </div>
        </div>
      </section>

      <section className={styles.metricStrip} aria-label="主要實測指標">
        {headlineMetrics.map((metric) => (
          <div key={metric.label}>
            <strong>{metric.value}{metric.unit ? <small>{metric.unit}</small> : null}</strong>
            <span>{metric.label}</span>
          </div>
        ))}
      </section>

      <section className={styles.section} id="organizer">
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>10,000 人活動重點</p>
          <h2>4 組核心數字，<br />呈現完整入場能力。</h2>
          <p>10,000 人容量、50 個入口、496.86 req/s 與 10,000 / 10,000 資料一致。</p>
        </div>
        <div className={styles.outcomeGrid}>
          {organizerOutcomes.map((outcome) => (
            <article className={styles.outcomeCard} key={outcome.number}>
              <span className={styles.cardNumber}>{outcome.number}</span>
              <h3>{outcome.title}</h3>
              <p>{outcome.body}</p>
              <strong><i aria-hidden="true">✓</i>{outcome.proof}</strong>
            </article>
          ))}
        </div>
      </section>

      <section className={`${styles.section} ${styles.resultsSection}`} id="results">
        <div className={styles.resultsCopy}>
          <p className={styles.kicker}>10,542 次實際請求</p>
          <h2>10,542 次掃描請求，<br />0 次非預期失敗。</h2>
          <p>
            測試流程涵蓋名單匯入、工作站授權、一般掃描、同票競態、未知票券、名單復原、活動紀錄與投影同步。
          </p>
          <div className={styles.responsePills}>
            <span><i className={styles.successDot} />10,002 成功回應</span>
            <span><i className={styles.duplicateDot} />490 已報到回應</span>
            <span><i className={styles.unknownDot} />50 筆未知票券</span>
          </div>
        </div>
        <div className={styles.latencyCard}>
          <div className={styles.latencyHead}>
            <div><span>掃描 API 回應時間</span><small>95.8–384.8 ms</small></div>
            <strong>p50 <em>95.8 ms</em></strong>
          </div>
          <div className={styles.latencyRows}>
            {latencyRows.map((row) => (
              <div className={styles.latencyRow} key={row.label}>
                <span>{row.label}</span>
                <div><i style={{ "--bar-width": row.width } as CSSProperties} /></div>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
          <p>本頁顯示本次本機環境觀測值。現場結果依網路、資料庫區域、設備與瀏覽器條件變化。</p>
        </div>
      </section>

      <section className={`${styles.section} ${styles.safetySection}`}>
        <div className={styles.safetyPanel}>
          <div className={styles.safetyHeading}>
            <span className={styles.passSeal}>21/21<small>PASS</small></span>
            <div>
              <p className={styles.kicker}>21 / 21 檢查通過</p>
              <h2>21 / 21 項一致性檢查通過。</h2>
              <p>測試涵蓋工作站授權、重複防護、容量邊界、資料復原與跨畫面一致性。</p>
            </div>
          </div>
          <div className={styles.checkGrid}>
            {verifiedChecks.map((item) => (
              <div key={item}><i aria-hidden="true">✓</i><span>{item}</span></div>
            ))}
          </div>
        </div>
      </section>

      <section className={`${styles.section} ${styles.methodSection}`} id="method">
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>5 階段測試流程</p>
          <h2>5 個階段，<br />完成一次萬人模擬入場。</h2>
          <p>測試腳本建立獨立活動，依序完成匯入、開站、掃描、搶刷與對帳，最後清除測試資料。</p>
        </div>
        <ol className={styles.testFlow}>
          {testSteps.map((step, index) => (
            <li key={step.label}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><small>{step.label}</small><strong>{step.value}</strong><p>{step.note}</p></div>
            </li>
          ))}
        </ol>
        <aside className={styles.disclosure}>
          <strong>測試條件</strong>
          <p>
            本次工程壓測於 2026-08-08 的本機環境執行。正式活動的回應時間取決於現場網路、資料庫區域、入口配置、設備與瀏覽器。主辦單位可使用同一份 10,000 人測試包完成場地演練。
          </p>
        </aside>
      </section>

      <section className={styles.ctaSection}>
        <div>
          <p className={styles.kicker}>10,000 人測試包</p>
          <h2>下載 10,000 人名單，<br />完成一次場地演練。</h2>
          <p>150 人與 10,000 人測試包共用 QR Code。先完成 150 人流程，再執行 10,000 人容量演練。</p>
        </div>
        <div className={styles.ctaActions}>
          <a className={styles.lightAction} href="/checkin-pod-sample-150.zip" download>下載 150 人測試包</a>
          <a className={styles.orangeAction} href="/checkin-pod-sample-10000.zip" download>下載 10,000 人測試包</a>
        </div>
      </section>

      <footer className={styles.footer}>
        <Brand />
        <p>50 個入口同步工作，每一筆報到維持唯一。</p>
        <nav aria-label="公開頁面">
          <a href="/scan">來賓畫面</a>
          <a href="/projection">投影畫面</a>
          <a href="/">中控台登入</a>
        </nav>
      </footer>
    </main>
  );
}
