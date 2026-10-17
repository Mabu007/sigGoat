import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type SeriesMarker,
} from 'lightweight-charts';
import type { Candle, MarketQuote } from '../types';
import { useTheme } from '../context/ThemeContext';
import './trade-room-chart.css';

type AgentChartEvent = {
  id: string;
  time: number;
  price?: number;
  direction: string;
  label: string;
};

interface ChartProps {
  candles: Candle[];
  activeQuote: MarketQuote | null;
  timeframe: string;
  symbol: string;
  digits?: number;
  roomName?: string;
  agentEvents?: AgentChartEvent[];
  dataMode?: string;
}

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

function isFreshQuote(quote: MarketQuote | null) {
  if (!quote || quote.stale || !Number.isFinite(quote.mid) || quote.mid <= 0) return false;
  if (typeof quote.quoteAgeSeconds === 'number' && quote.quoteAgeSeconds > 60) return false;
  return true;
}

export const TradingViewLightweightChart: React.FC<ChartProps> = ({
  candles, activeQuote, timeframe, symbol, digits = 5, roomName, agentEvents = [], dataMode = '',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const palette = useMemo(() => readChartPalette(), [theme]);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markerPluginRef = useRef<{ setMarkers: (markers: SeriesMarker<Time>[]) => void } | null>(null);
  const priceLineRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const lastBarsRef = useRef<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>>([]);
  const lastTimeframeRef = useRef(timeframe);
  const shouldFitRef = useRef(true);
  const userInteractedRef = useRef(false);
  const [crosshairBar, setCrosshairBar] = useState<{ open: number; high: number; low: number; close: number } | null>(null);

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

    const onRangeChange = () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      const bars = lastBarsRef.current;
      if (!range || bars.length === 0) return;
      userInteractedRef.current = range.to < bars.length - 1.5;
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
    const normalized = normalizeCandles(candles);
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
      candleSeries.setData(nextBars);
      volumeSeries.setData(nextVolumes);
      if (shouldFitRef.current || previous.length === 0) {
        chart.timeScale().fitContent();
        shouldFitRef.current = false;
        userInteractedRef.current = false;
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
  }, [candles, timeframe, agentEvents, palette]);

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
  }, [activeQuote, timeframe, dataMode]);

  return (
    <div className="sg-pulse-chart" data-theme={theme}>
      <div className="sg-pulse-watermark" aria-hidden="true">{roomName || 'SIRGOAT'}</div>
      {crosshairBar && <div className="sg-pulse-ohlc" aria-label="Selected candle OHLC">
        <span>O <b>{crosshairBar.open.toLocaleString(undefined, { maximumFractionDigits: digits })}</b></span>
        <span>H <b>{crosshairBar.high.toLocaleString(undefined, { maximumFractionDigits: digits })}</b></span>
        <span>L <b>{crosshairBar.low.toLocaleString(undefined, { maximumFractionDigits: digits })}</b></span>
        <span>C <b>{crosshairBar.close.toLocaleString(undefined, { maximumFractionDigits: digits })}</b></span>
      </div>}
      <div ref={containerRef} className="sg-pulse-canvas" aria-label={symbol + ' ' + timeframe + ' candlestick chart'} />
      {activeQuote && isFreshQuote(activeQuote) && dataMode.toUpperCase() !== 'PAPER' && <div className="sg-pulse-live-pip" aria-hidden="true" />}
    </div>
  );
};
