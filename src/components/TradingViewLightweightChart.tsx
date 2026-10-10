import React, { useEffect, useMemo, useRef } from 'react';
import {
  createChart,
  ColorType,
  IChartApi,
  CandlestickSeries,
  HistogramSeries,
  ISeriesApi,
  Time,
} from 'lightweight-charts';
import { Candle, MarketQuote } from '../types';
import { useTheme } from '../context/ThemeContext';

/**
 * Chart palette, read from the CSS custom properties.
 *
 * The chart renders to a CANVAS, so it cannot inherit CSS. Reading the tokens
 * off the document is what keeps it in the active theme — the hard-coded
 * `#090c12` it used to carry is exactly why a light theme would have produced
 * a black chart on a white page.
 *
 * Read once per theme change rather than per render; `getComputedStyle` is not
 * free and the values only change with the theme.
 */
function readChartPalette() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    sunken: token('--color-sunken', '#0d1015'),
    grid: token('--color-line', '#232833'),
    border: token('--color-line-strong', '#333a48'),
    textMuted: token('--color-fg-subtle', '#6d7688'),
    accent: token('--color-accent-text', '#fbbf24'),
    labelBackground: token('--color-raised', '#171b24'),
    positive: token('--color-positive', '#34d399'),
    negative: token('--color-negative', '#fb7185'),
    volumeBase: token('--color-line-strong', '#333a48'),
    volumePositive: token('--color-positive', '#34d399'),
    volumeNegative: token('--color-negative', '#fb7185'),
  };
}

interface ChartProps {
  candles: Candle[];
  activeQuote: MarketQuote | null;
  timeframe: string;
  symbol: string;
  digits?: number;
}

export const TradingViewLightweightChart: React.FC<ChartProps> = ({
  candles,
  activeQuote,
  timeframe,
  symbol,
  digits = 5,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const palette = useMemo(() => readChartPalette(), [theme]);

  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create TradingView Lightweight Chart instance
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: palette.sunken },
        textColor: palette.textMuted,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(30, 41, 59, 0.5)' },
        horzLines: { color: 'rgba(30, 41, 59, 0.5)' },
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: palette.accent,
          width: 1,
          style: 3,
          labelBackgroundColor: palette.labelBackground,
        },
        horzLine: {
          color: palette.accent,
          width: 1,
          style: 3,
          labelBackgroundColor: palette.labelBackground,
        },
      },
      timeScale: {
        borderColor: palette.border,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: palette.border,
        scaleMargins: {
          top: 0.1,
          bottom: 0.2,
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: palette.positive,
      downColor: palette.negative,
      borderVisible: false,
      wickUpColor: palette.positive,
      wickDownColor: palette.negative,
      priceFormat: {
        type: 'price',
        precision: digits,
        minMove: 1 / Math.pow(10, digits),
      },
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: palette.volumeBase,
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '', // overlay volume
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Responsive container resize observer
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0 || !chartRef.current || !containerRef.current) return;
      const { width, height } = containerRef.current.getBoundingClientRect();
      chartRef.current.applyOptions({ width, height: Math.max(height, 280) });
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [symbol, digits]);

  // Set historical data whenever candles change
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current || candles.length === 0) return;

    // Filter, deduplicate, and sort ascending by time
    const seenTimes = new Set<number>();
    const formattedCandles: any[] = [];
    const formattedVolumes: any[] = [];

    // Sort ascending
    const sorted = [...candles].sort((a, b) => a.time - b.time);

    for (const c of sorted) {
      // Lightweight charts expects time in seconds or business day
      const timeInSec = Math.floor(c.time / 1000) as Time;
      if (seenTimes.has(Number(timeInSec))) continue;
      seenTimes.add(Number(timeInSec));

      formattedCandles.push({
        time: timeInSec,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      });

      formattedVolumes.push({
        time: timeInSec,
        value: c.volume || 1000,
        color: c.close >= c.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(244, 63, 94, 0.35)',
      });
    }

    try {
      candleSeriesRef.current.setData(formattedCandles);
      volumeSeriesRef.current.setData(formattedVolumes);
      chartRef.current?.timeScale().fitContent();
    } catch (err) {
      console.warn('Lightweight chart setData error:', err);
    }
  }, [candles]);

  // Update current bar with live quote
  useEffect(() => {
    if (!candleSeriesRef.current || !activeQuote || candles.length === 0) return;

    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) return;

    const timeInSec = Math.floor(lastCandle.time / 1000) as Time;
    const currentPrice = activeQuote.mid;

    try {
      candleSeriesRef.current.update({
        time: timeInSec,
        open: lastCandle.open,
        high: Math.max(lastCandle.high, currentPrice),
        low: Math.min(lastCandle.low, currentPrice),
        close: currentPrice,
      });
    } catch {
      // Ignore transient boundary update
    }
  }, [activeQuote, candles]);

  return (
    <div className="w-full h-full relative">
      <div ref={containerRef} className="w-full h-[360px] sm:h-[420px] rounded-xl overflow-hidden" />
    </div>
  );
};
