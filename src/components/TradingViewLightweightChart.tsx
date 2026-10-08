import React, { useEffect, useRef } from 'react';
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
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create TradingView Lightweight Chart instance
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#090c12' },
        textColor: '#94a3b8',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(30, 41, 59, 0.5)' },
        horzLines: { color: 'rgba(30, 41, 59, 0.5)' },
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: '#f59e0b',
          width: 1,
          style: 3,
          labelBackgroundColor: '#1e293b',
        },
        horzLine: {
          color: '#f59e0b',
          width: 1,
          style: 3,
          labelBackgroundColor: '#1e293b',
        },
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#1e293b',
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
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
      priceFormat: {
        type: 'price',
        precision: digits,
        minMove: 1 / Math.pow(10, digits),
      },
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: '#334155',
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
