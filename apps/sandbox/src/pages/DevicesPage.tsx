import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorBox } from '../components/ErrorBox';
import { call } from '../lib/servers';
import { kstTime } from '../lib/time';
import type { SimConfig, SimDevices, SimStats } from '../lib/types';

/** 통계·단말기 표를 다시 읽는 간격 */
const POLL_MS = 3000;
/** 표에 보이는 단말기 수(수 넷은 전체를 센다) */
const DEVICE_LIMIT = 100;
const keys = { all: ['sim'] as const, config: ['sim', 'config'] as const, stats: ['sim', 'stats'] as const, devices: ['sim', 'devices'] as const };

/**
 * 단말기 시뮬레이터(보강 8): 시작·정지, 설정, 보낸 것(통계), 단말기 표(하나씩 끄고 켜기).
 * 끄고 켜기는 설정의 offlineSerials를 바꾼다 — 시뮬레이터가 돌던 중이면 멈췄다가 새 설정으로 다시 돈다(device-sim server.ts).
 */
export function DevicesPage() {
  const client = useQueryClient();
  const config = useQuery({ queryKey: keys.config, queryFn: () => call<SimConfig>('sim', '/__admin/config') });
  const stats = useQuery({ queryKey: keys.stats, queryFn: () => call<SimStats>('sim', '/__admin/stats'), refetchInterval: POLL_MS });
  const devices = useQuery({ queryKey: keys.devices, queryFn: () => call<SimDevices>('sim', `/__admin/devices?limit=${DEVICE_LIMIT}`), refetchInterval: POLL_MS });
  const refresh = () => client.invalidateQueries({ queryKey: keys.all });
  const run = useMutation({ mutationFn: (path: '/__admin/start' | '/__admin/stop') => call('sim', path, { method: 'POST' }), onSuccess: refresh });
  const saved = (c: SimConfig) => {
    client.setQueryData(keys.config, c);
    void refresh();
  };
  const configure = useMutation({ mutationFn: (patch: Partial<SimConfig>) => call<SimConfig>('sim', '/__admin/config', { method: 'POST', body: patch }), onSuccess: saved });
  // 끄고 켜기는 그때 서버의 offlineSerials를 다시 읽어 바꾼다 — 캐시한 목록으로 보내면 다른 곳(다른 탭·스크립트)에서 바꾼 것을 덮는다(최종 검토)
  const toggle = useMutation({
    mutationFn: async ({ serialNo, offline }: { serialNo: string; offline: boolean }) => {
      const current = (await call<SimConfig>('sim', '/__admin/config')).offlineSerials;
      const offlineSerials = offline ? [...current.filter((s) => s !== serialNo), serialNo] : current.filter((s) => s !== serialNo);
      return call<SimConfig>('sim', '/__admin/config', { method: 'POST', body: { offlineSerials } });
    },
    onSuccess: saved,
  });
  const running = stats.data?.running ?? false;
  // 오프라인 비율이 있으면 꺼진 단말기는 하나씩 켤 수 없다 — 시뮬레이터가 offlineSerials와 비율로 고른 단말기를 합쳐서, 목록에서 빼도 비율 쪽이면 그대로 꺼져 있다
  const byRate = (config.data?.offlineRate ?? 0) > 0;
  return (
    <>
      <div className="head-row">
        <div>
          <h1>단말기 시뮬레이터</h1>
          <p className="muted lead">가짜 단말기가 주기마다 우리 api에 하트비트를 보내고, 펌웨어 업데이트 지시를 받으면 결과를 보고합니다.</p>
        </div>
        {stats.data ? (
          <div className="run">
            <span className={running ? 'state ok' : 'state'}>{running ? `도는 중 · 마지막 주기 ${kstTime(stats.data.lastTickAt)}` : '멈춤'}</span>
            {running ? (
              <button type="button" disabled={run.isPending} onClick={() => run.mutate('/__admin/stop')}>
                정지
              </button>
            ) : (
              <button type="button" className="primary" disabled={run.isPending} onClick={() => run.mutate('/__admin/start')}>
                시작
              </button>
            )}
          </div>
        ) : null}
      </div>
      <ErrorBox error={stats.error ?? run.error ?? configure.error ?? toggle.error} />
      <div className="split">
        <div>
          {stats.data ? <Stats stats={stats.data} /> : null}
          <section className="section" aria-label="단말기 목록">
            <h2>
              단말기{' '}
              {devices.data ? (
                <small className="muted">
                  전체 {devices.data.total} · 온라인 {devices.data.online} · 오프라인 {devices.data.offline} · 업데이트 중 {devices.data.updating}
                </small>
              ) : null}
            </h2>
            <ErrorBox error={devices.error} />
            {devices.data && config.data ? (
              <table aria-label="단말기">
                <thead>
                  <tr>
                    <th scope="col">시리얼</th>
                    <th scope="col">펌웨어</th>
                    <th scope="col">상태</th>
                    <th scope="col">
                      <span className="sr-only">끄고 켜기</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {devices.data.items.map((d) => {
                    const locked = d.offline && byRate;
                    return (
                      <tr key={d.serialNo} aria-label={d.serialNo}>
                        <td className="mono strong">{d.serialNo}</td>
                        <td className="mono">{d.firmwareVersion}</td>
                        <td>
                          <span className={d.offline ? 'state bad' : 'state ok'}>{d.offline ? '오프라인' : '온라인'}</span>
                          {d.updating ? <span className="state warn"> 업데이트 중</span> : null}
                        </td>
                        <td>
                          <button
                            type="button"
                            disabled={toggle.isPending || locked}
                            title={locked ? '오프라인 비율(offlineRate)이 0보다 크면 하나씩 켤 수 없습니다. 비율을 0으로 바꾸세요' : undefined}
                            onClick={() => toggle.mutate({ serialNo: d.serialNo, offline: !d.offline })}
                          >
                            {d.offline ? '켜기' : '끄기'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : null}
            {devices.data && devices.data.total > devices.data.items.length ? <p className="muted small">앞 {devices.data.items.length}대만 보입니다.</p> : null}
          </section>
        </div>
        {config.data ? (
          // 폼이 다루는 값이 바뀔 때만 새로 그린다 — 단말기 끄고 켜기(offlineSerials)로는 적던 값을 버리지 않는다(최종 검토)
          <ConfigForm key={formKey(config.data)} config={config.data} pending={configure.isPending} onSubmit={(p) => configure.mutate(p)} />
        ) : (
          <ErrorBox error={config.error} />
        )}
      </div>
    </>
  );
}

function Stats({ stats }: { stats: SimStats }) {
  const cells: [string, string | number, string?][] = [
    ['주기', stats.ticks, stats.skippedTicks ? `건너뜀 ${stats.skippedTicks}` : undefined],
    ['하트비트', stats.heartbeatsSent],
    ['받아들임', stats.heartbeatsAccepted],
    ['거절', stats.heartbeatsRejected, '운영 중이 아닌 단말기 등'],
    ['실패한 요청', stats.errors],
    ['응답 p50 / p95', `${Math.round(stats.latency.p50)} / ${Math.round(stats.latency.p95)}ms`],
    ['펌웨어 보고 성공 / 실패', `${stats.reportsSucceeded} / ${stats.reportsFailed}`, `받은 지시 ${stats.updateOffers}`],
  ];
  return (
    <section className="stats" aria-label="보낸 것">
      {cells.map(([label, value, note]) => (
        <div key={label} className={label === '실패한 요청' && stats.errors > 0 ? 'stat bad' : 'stat'}>
          <span className="label">{label}</span>
          <strong>{value}</strong>
          {note ? <small className="muted">{note}</small> : null}
        </div>
      ))}
    </section>
  );
}

const FORM_FIELDS = ['targetUrl', 'serialPrefix', 'serialStart', 'count', 'intervalMs', 'batchSize', 'firmwareFailRate', 'deviceKey'] as const;
const formKey = (c: SimConfig) => JSON.stringify(FORM_FIELDS.map((f) => c[f]));

/** 숫자 칸: 비었거나 숫자가 아니면 NaN(Number('')는 0이라 그대로 쓰면 "비우기 = 0"이 된다 — 최종 검토) */
const num = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));

/** 설정 폼 — 화면 단위(초·%)로 받고 바뀐 것만 서버 단위(ms·0~1)로 보낸다 */
function ConfigForm({ config, pending, onSubmit }: { config: SimConfig; pending: boolean; onSubmit: (patch: Partial<SimConfig>) => void }) {
  const [targetUrl, setTargetUrl] = useState(config.targetUrl);
  const [serialPrefix, setSerialPrefix] = useState(config.serialPrefix);
  const [count, setCount] = useState(String(config.count));
  const [intervalSec, setIntervalSec] = useState(String(config.intervalMs / 1000));
  const [batchSize, setBatchSize] = useState(String(config.batchSize));
  const [failPct, setFailPct] = useState(String(Math.round(config.firmwareFailRate * 10_000) / 100));
  const next: Partial<SimConfig> = {
    targetUrl: targetUrl.trim(),
    serialPrefix: serialPrefix.trim(),
    count: num(count),
    intervalMs: Math.round(num(intervalSec) * 1000),
    batchSize: num(batchSize),
    firmwareFailRate: Math.round(num(failPct) * 100) / 10_000,
  };
  const patch = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== config[k as keyof SimConfig])) as Partial<SimConfig>;
  const valid = Object.values(next).every((v) => (typeof v === 'number' ? Number.isFinite(v) : v !== ''));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(patch);
  };
  return (
    <form className="panel form" aria-label="시뮬레이터 설정" onSubmit={submit}>
      <h2>설정</h2>
      <label>
        대상 api 주소
        <input aria-label="대상 api 주소" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
      </label>
      <div className="two">
        <label>
          시리얼 앞글자
          <input aria-label="시리얼 앞글자" value={serialPrefix} onChange={(e) => setSerialPrefix(e.target.value)} />
        </label>
        <label>
          대수
          <input aria-label="대수" type="number" min={0} max={20000} value={count} onChange={(e) => setCount(e.target.value)} />
        </label>
      </div>
      <div className="two">
        <label>
          주기(초)
          <input aria-label="주기(초)" type="number" min={1} step="any" value={intervalSec} onChange={(e) => setIntervalSec(e.target.value)} />
        </label>
        <label>
          묶음 크기
          <input aria-label="묶음 크기" type="number" min={1} max={500} value={batchSize} onChange={(e) => setBatchSize(e.target.value)} />
        </label>
      </div>
      <label>
        펌웨어 실패율(%)
        <input aria-label="펌웨어 실패율(%)" type="number" min={0} max={100} step="any" value={failPct} onChange={(e) => setFailPct(e.target.value)} />
      </label>
      <small className="hint">
        시리얼은 {serialPrefix || '?'}-{String(config.serialStart).padStart(4, '0')}부터. api에 운영 중으로 있는 시리얼이어야 하트비트가 받아들여집니다. 단말기 키는 시뮬레이터의 DEVICE_API_KEY({config.deviceKey ? '설정됨' : '없음'})
      </small>
      <button type="submit" className="primary" disabled={!valid || Object.keys(patch).length === 0 || pending}>
        설정 적용
      </button>
    </form>
  );
}
