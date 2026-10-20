import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ITimeScaleApi,
  type LineWidth,
  type Time,
  type SeriesMarker,
} from 'lightweight-charts';
import type { Candle, MarketQuote } from '../types';
import { useTheme } from '../context/ThemeContext';
import {
  computeRoomIndicators,
  normalizeRoomCandles,
  type RoomIndicatorConfig,
  type RoomIndicatorOutput,
} from './room-chart/roomIndicators';

type AgentChartEvent = {
  id: string;
  time: number;
  price?: number;
  direction: string;
  label: string;
};

/**
 * The chart handles a parent may need in order to draw on top of, or beside,
 * the candle series.
 *
 * `candleSeries` is the anchor for every price conversion, and `timeScale`
 * for every time conversion, so a parent that draws an overlay MUST use
 * these two rather than its own maths — the chart owns the mapping between
 * a price and a pixel.
 */
export interface RoomChartApi {
  chart: IChartApi;
  candleSeries: ISeriesApi<'Candlestick'>;
  timeScale: () => ITimeScaleApi<Time>;
}

export interface ChartProps {
  candles: Candle[];
  activeQuote: MarketQuote | null;
  timeframe: string;
  symbol: string;
  digits?: number;
  roomName?: string;
  agentEvents?: AgentChartEvent[];
  dataMode?: string;
  /** Draw the volume histogram. Defaults to true. */
  showVolume?: boolean;
  /**
   * Indicators to draw on the chart.
   *
   * The chart renders them itself so it can remove the series again when an
   * indicator is switched off or the chart is rebuilt — a parent that added
   * its own series would have to clean them up too, and the usual result is
   * a chart with three copies of the same moving average.
   */
  indicators?: RoomIndicatorConfig[];
  /**
   * Called with the live chart handles once the chart exists. Called again
   * with fresh handles whenever the chart is rebuilt (symbol, precision or
   * theme change); the previous handles are dead by then.
   */
  onChartReady?: (api: RoomChartApi) => void;
  /**
   * Rendered as an absolutely positioned layer over the chart canvas.
   *
   * The layer does NOT receive pointer events unless it asks for them, so
   * the chart keeps its own pan and zoom.
   */
  overlay?: React.ReactNode;
}

export type TradingViewLightweightChartProps = ChartProps;

function readChartPalette() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--color-sunken', '#0b1016'),
    grid: 'rgba(120, 145, 165, 0.09)',
    border: token('--color-line-strong', '#273442'),
    text: token('--color-fg-subtle', '#7d8b9b'),
    accent: '#79e5c2',
    labelBackground: '#14212a',
    up: '#53dfb0',
    down: '#ff7185',
    volumeUp: 'rgba(83, 223, 176, 0.25)',
    volumeDown: 'rgba(255, 113, 133, 0.25)',
  };
}

function normalizeCandles(input: Candle[]) {
  const byTime = new Map<number, Candle>();
  for (const candle of input) {
    if (!Number.isFinite(candle.time) || candle.time <= 0) continue;
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) continue;
    if (candle.high < Math.max(candle.open, candle.close, candle.low)) continue;
    if (candle.low > Math.min(candle.open, candle.close, candle.high)) continue;
    byTime.set(Math.floor(candle.time / 1000), candle);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, candle]) => ({ ...candle, time }));
}

/** Bars shown before the user scrolls back into history. */
const INITIAL_VISIBLE_BARS = 180;
/** Bars added per reveal, and how close to the left edge triggers one. */
const REVEAL_CHUNK = 300;
const REVEAL_TRIGGER_FROM = 40;

function isFreshQuote(quote: MarketQuote | null) {
  if (!quote || quote.stale || !Number.isFinite(quote.mid) || quote.mid <= 0) return false;
  if (typeof quote.quoteAgeSeconds === 'number' && quote.quoteAgeSeconds > 60) return false;
  if (Number.isFinite(quote.timestamp) && quote.timestamp > 1_000_000_000) {
    const timestampMs = quote.timestamp > 1_000_000_000_000 ? quote.timestamp : quote.timestamp * 1000;
    if (Date.now() - timestampMs > 60_000) return false;
  }
  return true;
}

/** One indicator's live series, plus the pane it lives in. */
interface IndicatorRuntime {
  /** The chart the series belong to. Used to detect a rebuilt chart. */
  chart: IChartApi;
  output: RoomIndicatorOutput;
  lines: Array<{ id: string; series: ISeriesApi<'Line'> }>;
  histogram?: ISeriesApi<'Histogram'>;
  /** Set only for indicators that own a pane. */
  paneIndex?: number;
}

export const TradingViewLightweightChart: React.FC<ChartProps> = ({
  candles, activeQuote, timeframe, symbol, digits = 5, roomName, agentEvents = [], dataMode = '',
  showVolume = true, indicators, onChartReady, overlay,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const palette = useMemo(() => readChartPalette(), [theme]);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markerPluginRef = useRef<{ setMarkers: (markers: SeriesMarker<Time>[]) => void } | null>(null);
  const priceLineRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const lastBarsRef = useRef<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>>([]);
  const lastTimeframeRef = useRef(timeframe);
  const shouldFitRef = useRef(true);
  const userInteractedRef = useRef(false);
  const [crosshairBar, setCrosshairBar] = useState<{ open: number; high: number; low: number; close: number } | null>(null);

  /**
   * Callbacks and flags the chart reads inside effects that must NOT be
   * re-created when a parent passes a new inline function. A parent that
   * renders `onChartReady={(api) => ...}` inline would otherwise rebuild
   * the whole chart on every render.
   */
  const onChartReadyRef = useRef(onChartReady);
  onChartReadyRef.current = onChartReady;

  /**
   * How much of the fetched history is on screen.
   *
   * The full series is fetched once — 500 five-minute bars cost the same
   * upstream request as 160, and re-fetching on every pan back would be both
   * slower and rate-limit-hungry. Rendering all of them at once is the
   * problem instead: 500 bars in a 1000px pane is two pixels each, which is
   * unreadable. So the chart holds a window and widens it as the user scrolls
   * back into history, revealing older bars into an already-loaded series.
   */
  const [revealed, setRevealed] = useState(INITIAL_VISIBLE_BARS);
  useEffect(() => {
    // A shorter series (timeframe switch, or a room with thin history) must
    // not leave the chart showing fewer bars than it has.
    setRevealed(current => Math.min(Math.max(current, INITIAL_VISIBLE_BARS), candles.length));
  }, [candles.length]);
  const visibleCandles = useMemo(
    () => (candles.length > revealed ? candles.slice(-revealed) : candles),
    [candles, revealed],
  );

  /**
   * The indicator request, flattened to a stable string.
   *
   * The indicator lifecycle is keyed on this rather than on the array
   * identity, because a parent that builds the array inline would otherwise
   * tear the series down and rebuild them on every single render.
   */
  const indicatorKey = useMemo(() => JSON.stringify(indicators ?? []), [indicators]);
  const indicatorConfigs = useMemo<RoomIndicatorConfig[]>(
    () => (indicators ?? []),
    [indicatorKey],
  );
  const indicatorCandles = useMemo(() => normalizeRoomCandles(visibleCandles), [visibleCandles]);
  const indicatorOutputs = useMemo(
    () => computeRoomIndicators(indicatorCandles, indicatorConfigs),
    [indicatorCandles, indicatorConfigs],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'rgba(11, 16, 22, 0)' },
        textColor: palette.text,
        fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      crosshair: {
        mode: 0,
        vertLine: { color: 'rgba(121, 229, 194, .72)', width: 1, style: 2, labelBackgroundColor: '#16382f' },
        horzLine: { color: 'rgba(121, 229, 194, .72)', width: 1, style: 2, labelBackgroundColor: '#16382f' },
      },
      timeScale: {
        borderColor: palette.border,
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 7,
        minBarSpacing: 2,
        rightOffset: 7,
        fixLeftEdge: false,
        fixRightEdge: false,
        lockVisibleTimeRangeOnResize: true,
        rightBarStaysOnScroll: true,
      },
      rightPriceScale: {
        borderColor: palette.border,
        autoScale: true,
        scaleMargins: { top: 0.1, bottom: 0.2 },
        entireTextOnly: true,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      kineticScroll: { mouse: true, touch: true },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderVisible: false,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
      wickVisible: true,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: 'price', precision: digits, minMove: 1 / Math.pow(10, digits) },
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    markerPluginRef.current = createSeriesMarkers(candleSeries, []);

    onChartReadyRef.current?.({
      chart,
      candleSeries,
      timeScale: () => chart.timeScale(),
    });

    const onRangeChange = () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      const bars = lastBarsRef.current;
      if (!range || bars.length === 0) return;
      userInteractedRef.current = range.to < bars.length - 1.5;
      /**
       * Scrolled back to the start of what is on screen: reveal another chunk
       * of already-fetched history. Guarded by `bars.length < total` so this
       * fires once per chunk rather than on every pixel of a pan.
       */
      if (range.from <= REVEAL_TRIGGER_FROM && bars.length < candlesRef.current.length) {
        setRevealed(current => Math.min(current + REVEAL_CHUNK, candlesRef.current.length));
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
    const onCrosshairMove = (param: any) => {
      const bar = param.seriesData?.get(candleSeries) as { open?: number; high?: number; low?: number; close?: number } | undefined;
      if (bar && Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close)) {
        setCrosshairBar({ open: bar.open!, high: bar.high!, low: bar.low!, close: bar.close! });
      } else {
        const latest = lastBarsRef.current.at(-1);
        setCrosshairBar(latest ? { open: latest.open, high: latest.high, low: latest.low, close: latest.close } : null);
      }
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    const observer = new ResizeObserver(() => {
      if (!container.isConnected) return;
      const { width, height } = container.getBoundingClientRect();
      if (width > 0 && height > 0) chart.applyOptions({ width, height });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markerPluginRef.current = null;
      priceLineRef.current = null;
      lastBarsRef.current = [];
    };
  }, [symbol, digits, palette]);

  useEffect(() => {
    if (lastTimeframeRef.current !== timeframe) {
      lastTimeframeRef.current = timeframe;
      shouldFitRef.current = true;
      userInteractedRef.current = false;
    }
  }, [timeframe]);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart) return;
    const normalized = normalizeCandles(visibleCandles);
    if (normalized.length === 0) {
      candleSeries.setData([]);
      volumeSeries.setData([]);
      lastBarsRef.current = [];
      markerPluginRef.current?.setMarkers([]);
      return;
    }

    const nextBars = normalized.map(c => ({
      time: c.time as Time,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    const nextVolumes = normalized.map(c => ({
      time: c.time as Time,
      value: Math.max(0, Number.isFinite(c.volume) ? c.volume : 0),
      color: c.close >= c.open ? palette.volumeUp : palette.volumeDown,
    }));
    const previous = lastBarsRef.current;
    const sameTimeline = previous.length === nextBars.length &&
      previous.every((bar, index) => Number(bar.time) === Number(nextBars[index].time));
    const olderBarsChanged = sameTimeline && previous.length > 1 && previous.slice(0, -1).some((bar, index) =>
      bar.open !== nextBars[index].open || bar.high !== nextBars[index].high ||
      bar.low !== nextBars[index].low || bar.close !== nextBars[index].close
    );
    const onlyLastBarChanged = sameTimeline && !olderBarsChanged;

    if (onlyLastBarChanged) {
      const last = nextBars[nextBars.length - 1];
      const lastVolume = nextVolumes[nextVolumes.length - 1];
      candleSeries.update(last);
      volumeSeries.update(lastVolume);
    } else {
      const oldRange = chart.timeScale().getVisibleLogicalRange();
      const wasAtLiveEdge = !userInteractedRef.current || !oldRange || oldRange.to >= previous.length - 2;
      /**
       * Bars were PREPENDED — the user scrolled back into history and a chunk
       * of already-fetched history was revealed. `setData` rewrites the whole
       * series, so every logical index shifts right by however many bars were
       * added; without compensating, the viewport would jump forward by that
       * amount on every reveal, which is the opposite of scrolling back.
       */
      const prepended = oldRange && nextBars.length > previous.length;
      candleSeries.setData(nextBars);
      volumeSeries.setData(nextVolumes);
      if (shouldFitRef.current || previous.length === 0) {
        chart.timeScale().fitContent();
        shouldFitRef.current = false;
        userInteractedRef.current = false;
      } else if (prepended) {
        const added = nextBars.length - previous.length;
        chart.timeScale().setVisibleLogicalRange({ from: oldRange!.from + added, to: oldRange!.to + added });
      } else if (wasAtLiveEdge) {
        chart.timeScale().scrollToRealTime();
      } else if (oldRange) {
        const max = nextBars.length - 1;
        const from = Math.max(0, Math.min(oldRange.from, max));
        const to = Math.max(from + 1, Math.min(oldRange.to, max + 7));
        chart.timeScale().setVisibleLogicalRange({ from, to });
      }
    }
    lastBarsRef.current = normalized.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));

    const firstTime = normalized[0].time;
    const lastTime = normalized[normalized.length - 1].time;
    const markers: SeriesMarker<Time>[] = agentEvents
      .filter(event => Number.isFinite(event.time) && event.time > 0 && event.time / 1000 >= firstTime && event.time / 1000 <= lastTime)
      .map(event => {
        const isLong = /long|bull|buy/i.test(event.direction);
        return {
          time: Math.floor(event.time / 1000) as Time,
          position: isLong ? 'belowBar' : 'aboveBar',
          color: isLong ? palette.up : palette.down,
          shape: isLong ? 'arrowUp' : 'arrowDown',
          text: event.label.slice(0, 24),
        } as SeriesMarker<Time>;
      });
    markerPluginRef.current?.setMarkers(markers);
  }, [visibleCandles, timeframe, agentEvents, palette, symbol]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    if (priceLineRef.current) {
      series.removePriceLine(priceLineRef.current);
      priceLineRef.current = null;
    }
    if (!activeQuote || !Number.isFinite(activeQuote.mid) || activeQuote.mid <= 0) return;
    const fresh = isFreshQuote(activeQuote) && dataMode.toUpperCase() !== 'PAPER';
    priceLineRef.current = series.createPriceLine({
      price: activeQuote.mid,
      color: fresh ? '#79e5c2' : '#d7a85c',
      lineWidth: 1,
      lineStyle: fresh ? 0 : 2,
      axisLabelVisible: true,
      title: dataMode.toUpperCase() === 'PAPER' ? 'PAPER' : fresh ? 'NOW' : 'LAST',
    });
  }, [activeQuote, timeframe, dataMode, symbol, palette]);

  /**
   * The volume histogram can be switched off, and is switched off by
   * itself when the provider supplied no volume at all: a histogram of
   * zeros is a lie about a market that does not report volume.
   */
  const hasVolumeData = useMemo(
    () => indicatorCandles.some(candle => candle.volume > 0),
    [indicatorCandles],
  );
  useEffect(() => {
    const volumeSeries = volumeSeriesRef.current;
    if (!volumeSeries) return;
    volumeSeries.applyOptions({ visible: showVolume && hasVolumeData });
  }, [showVolume, hasVolumeData, symbol, digits, palette]);

  /* ---------------------------------------------------------------- */
  /* Indicator series lifecycle                                       */
  /* ---------------------------------------------------------------- */

  const indicatorRuntimeRef = useRef<Map<string, IndicatorRuntime>>(new Map());
  /**
   * The evaluated indicators, always the current ones. The lifecycle effect
   * below reads them through this ref on purpose: it must NOT re-run when
   * only the candles change, or every tick would throw the series away and
   * build them again.
   */
  const indicatorOutputsRef = useRef(indicatorOutputs);
  indicatorOutputsRef.current = indicatorOutputs;

  /**
   * Creates the indicator series and the panes they live in.
   *
   * The teardown is the important half. Every series this effect created is
   * removed again when the configuration changes or the chart is rebuilt,
   * so toggling an indicator off leaves nothing behind — no orphan scale,
   * no second copy of the same moving average.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const previous = [...indicatorRuntimeRef.current.values()];
    indicatorRuntimeRef.current = new Map();

    for (const runtime of previous) {
      /**
       * A runtime from a DIFFERENT chart is already gone: that chart was
       * removed wholesale, and removing its series again would throw.
       */
      if (runtime.chart !== chart) continue;
      try {
        for (const line of runtime.lines) chart.removeSeries(line.series);
        if (runtime.histogram) chart.removeSeries(runtime.histogram);
      } catch {
        // The chart may have been torn down between the check and the call.
      }
    }
    /**
     * The panes are NOT removed by hand: the chart removes a pane by itself
     * as soon as its last series is gone, and removing one by index would
     * shift the indices of the panes after it — the wrong pane would be
     * dropped.
     */

    const runtime = new Map<string, IndicatorRuntime>();
    for (const output of indicatorOutputsRef.current) {
      let paneIndex = 0;
      if (output.ownPane) {
        const pane = chart.addPane();
        pane.setStretchFactor(0.3);
        paneIndex = pane.paneIndex();
      }
      const lines = output.lines.map(line => ({
        id: line.id,
        series: chart.addSeries(LineSeries, {
          color: line.color,
          lineWidth: Math.min(4, Math.max(1, Math.round(line.width))) as LineWidth,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceScaleId: 'right',
        }, paneIndex),
      }));
      const histogram = output.histogram
        ? chart.addSeries(HistogramSeries, {
          priceFormat: { type: 'price', precision: digits, minMove: 1 / Math.pow(10, digits) },
          priceLineVisible: false,
          lastValueVisible: false,
          priceScaleId: 'right',
        }, paneIndex)
        : undefined;

      /**
       * The pane's own price scale is used for the indicator, so the RSI
       * and the MACD are never stretched over the price scale of the
       * candles.
       *
       * Nothing is applied to that scale on purpose: in this library the
       * 'right' scale of a pane shares its options with the chart-wide
       * right scale, so setting a fixed range or custom margins here would
       * silently stop the MAIN price scale from auto-scaling, which is a
       * far worse bug than an axis that reads 30..70 instead of 0..100.
       * The latest value is in the legend instead.
       */
      runtime.set(output.key, {
        chart,
        output,
        lines,
        histogram,
        paneIndex: output.ownPane ? paneIndex : undefined,
      });
    }
    indicatorRuntimeRef.current = runtime;
  }, [symbol, digits, palette, indicatorKey]);

  /**
   * Feeds the indicator series.
   *
   * Kept apart from the creation effect so a new candle only updates the
   * data instead of throwing the series away and building them again.
   */
  useEffect(() => {
    const runtime = indicatorRuntimeRef.current;
    if (runtime.size === 0) return;
    for (const output of indicatorOutputs) {
      const entry = runtime.get(output.key);
      if (!entry) continue;
      for (const line of output.lines) {
        const target = entry.lines.find(candidate => candidate.id === line.id);
        if (!target) continue;
        target.series.setData(line.data.map(point => ({
          time: point.time as Time,
          value: point.value,
        })));
      }
      if (output.histogram && entry.histogram) {
        entry.histogram.setData(output.histogram.data.map(point => ({
          time: point.time as Time,
          value: point.value,
          color: point.color,
        })));
      }
    }
  }, [symbol, digits, palette, indicatorKey, indicatorOutputs]);

  return (
    <div className="sg-pulse-chart" data-theme={theme}>
      <div className="sg-pulse-watermark" aria-hidden="true">{roomName || 'TradingVibes'}</div>
      {crosshairBar && <div className="sg-pulse-ohlc" aria-label="Selected candle OHLC">
        <span>O <b>{crosshairBar.open.toLocaleString(undefined, { maximumFractionDigits: digits })}</b></span>
        <span>H <b>{crosshairBar.high.toLocaleString(undefined, { maximumFractionDigits: digits })}</b></span>
        <span>L <b>{crosshairBar.low.toLocaleString(undefined, { maximumFractionDigits: digits })}</b></span>
        <span>C <b>{crosshairBar.close.toLocaleString(undefined, { maximumFractionDigits: digits })}</b></span>
      </div>}
      <div ref={containerRef} className="sg-pulse-canvas" aria-label={symbol + ' ' + timeframe + ' candlestick chart'} />
      {overlay ? (
        <div className="pointer-events-none absolute inset-0 z-[2]">
          {overlay}
        </div>
      ) : null}
      {candles.length > revealed && (
        <div className="sg-pulse-history-hint" role="status">
          {revealed} of {candles.length} {timeframe} bars · scroll back for more
        </div>
      )}
      {activeQuote && isFreshQuote(activeQuote) && dataMode.toUpperCase() !== 'PAPER' && <div className="sg-pulse-live-pip" aria-hidden="true" />}
    </div>
  );
};
