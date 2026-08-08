import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import styles from "./benchmark.module.css";

const pageTitle = "Checkin Pod 效能實測｜10,000 人 × 50 個入口";
const pageDescription =
  "給活動主辦單位的公開效能示範：10,000 位來賓、50 個並行報到入口、重複掃描防護與完整名單復原實測。";

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
    title: "尖峰入場不必只開一個口",
    body: "50 個獨立工作站同時掃描，共享同一份即時名單；每個入口都有自己的安全連結與成功統計。",
    proof: "50 / 50 工作站驗證成功",
  },
  {
    number: "02",
    title: "同一張票搶刷，只會成功一次",
    body: "刻意讓 50 台工作站同時掃描同一張票，每一輪都只有一台成功，其餘立即標記為已報到。",
    proof: "10 輪競態全部正確",
  },
  {
    number: "03",
    title: "裝置資料遺失，名單仍可找回",
    body: "報到資料以伺服器為共同事實來源；測試中可重新發現活動並分頁復原全部名單與報到狀態。",
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
  "10,001 人超過容量時安全拒絕",
  "錯誤工作站憑證無法讀取或掃描",
  "工作站連結換發後，舊連結立即失效",
  "停用入口後，掃描請求立即被拒絕",
  "同一請求重送不會產生第二次報到",
  "未知票券全部正確辨識，不會誤放行",
  "工作站成功數與資料庫活動紀錄一致",
  "投影牆可取得完整 10,000 人狀態",
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
          <h1>大量入場，<br />每一個入口都拿到<br /><em>同一個正確答案。</em></h1>
          <p className={styles.heroLead}>
            給活動主辦單位的公開實測：從萬人名單匯入、多入口同時掃描，到同票搶刷與名單復原，逐項驗證現場最容易出錯的瞬間。
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
            <small>資料庫最終已報到</small>
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
            <small>其餘 49 台正確回報「已報到」</small>
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
          <p className={styles.kicker}>What organizers need to know</p>
          <h2>主辦單位真正需要放心的，<br />不是跑分，是現場不亂。</h2>
          <p>每一個數字都對應一個真實活動情境：入口暴增、票券重複、裝置異常，以及活動結束後的完整對帳。</p>
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
          <p className={styles.kicker}>Measured, not estimated</p>
          <h2>10,542 次掃描請求，<br />沒有非預期失敗。</h2>
          <p>
            測試不是把同一個 API 重複打滿，而是完整模擬名單匯入、工作站授權、一般掃描、同票競態、未知票券、復原、活動紀錄與投影同步。
          </p>
          <div className={styles.responsePills}>
            <span><i className={styles.successDot} />10,002 成功回應</span>
            <span><i className={styles.duplicateDot} />490 已報到回應</span>
            <span><i className={styles.unknownDot} />50 找不到資料</span>
          </div>
        </div>
        <div className={styles.latencyCard}>
          <div className={styles.latencyHead}>
            <div><span>掃描 API 回應時間</span><small>越短越快</small></div>
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
          <p>以上為本次本機環境觀測值；實際現場仍會受網路、資料庫區域、設備與瀏覽器影響。</p>
        </div>
      </section>

      <section className={`${styles.section} ${styles.safetySection}`}>
        <div className={styles.safetyPanel}>
          <div className={styles.safetyHeading}>
            <span className={styles.passSeal}>21/21<small>PASS</small></span>
            <div>
              <p className={styles.kicker}>Consistency & safety</p>
              <h2>速度之外，還要每一筆都對。</h2>
              <p>這次壓測同時檢查授權、重複防護、容量邊界、資料復原與跨畫面一致性。</p>
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
          <p className={styles.kicker}>How the test ran</p>
          <h2>不是單點跑分，<br />而是一場完整的模擬入場。</h2>
          <p>測試腳本建立獨立活動，完成所有檢查後自動清除測試資料，不與真實活動名單混用。</p>
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
          <strong>如何閱讀這份結果</strong>
          <p>
            這是 2026-08-08 於本機環境執行的工程壓力測試，用來驗證系統邏輯與容量邊界，不等同任何場地的服務水準保證。正式活動仍應依現場網路、入口配置與設備進行演練。
          </p>
        </aside>
      </section>

      <section className={styles.ctaSection}>
        <div>
          <p className={styles.kicker}>Try the same roster</p>
          <h2>把同一份萬人名單，<br />放進你的活動流程試一次。</h2>
          <p>兩份匿名測試包共用 QR Code，可先用 150 人快速熟悉，再換成 10,000 人檢查完整流程。</p>
        </div>
        <div className={styles.ctaActions}>
          <a className={styles.lightAction} href="/checkin-pod-sample-150.zip" download>下載 150 人測試包</a>
          <a className={styles.orangeAction} href="/checkin-pod-sample-10000.zip" download>下載 10,000 人測試包</a>
        </div>
      </section>

      <footer className={styles.footer}>
        <Brand />
        <p>讓多個入口一起工作，也讓每一筆報到只發生一次。</p>
        <nav aria-label="公開頁面">
          <a href="/scan">來賓畫面</a>
          <a href="/projection">投影畫面</a>
          <a href="/">中控台登入</a>
        </nav>
      </footer>
    </main>
  );
}
