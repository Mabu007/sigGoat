export interface MarketSessionInfo {
  session: 'LONDON_OPEN' | 'NEW_YORK_OPEN' | 'ASIAN_OPEN' | 'INTER_SESSION';
  name: string;
  utcTimeWindow: string;
  isTransitionActive: boolean;
  minutesUntilNextSession: number;
  nextSessionName: string;
}

export class SessionSchedule {
  /**
   * Evaluates current market session and returns scheduled review status
   */
  static getCurrentSession(): MarketSessionInfo {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    const currentMinOfDay = utcHour * 60 + utcMin;

    // London Open transition: ~07:00 - 08:30 UTC (420 - 510 mins)
    const londonOpenMin = 7 * 60; // 07:00 UTC
    // New York Open transition: ~12:30 - 14:00 UTC (750 - 840 mins)
    const nyOpenMin = 13 * 60; // 13:00 UTC
    // Asian Open transition: ~00:00 - 01:30 UTC (0 - 90 mins)
    const asianOpenMin = 0; // 00:00 UTC

    let session: 'LONDON_OPEN' | 'NEW_YORK_OPEN' | 'ASIAN_OPEN' | 'INTER_SESSION' = 'INTER_SESSION';
    let name = 'Regular Inter-Session Market';
    let utcTimeWindow = `${String(utcHour).padStart(2, '0')}:${String(utcMin).padStart(2, '0')} UTC`;
    let isTransitionActive = false;

    if (currentMinOfDay >= 420 && currentMinOfDay <= 510) {
      session = 'LONDON_OPEN';
      name = 'London Session Open';
      isTransitionActive = true;
    } else if (currentMinOfDay >= 750 && currentMinOfDay <= 840) {
      session = 'NEW_YORK_OPEN';
      name = 'New York Session Open';
      isTransitionActive = true;
    } else if (currentMinOfDay >= 0 && currentMinOfDay <= 90) {
      session = 'ASIAN_OPEN';
      name = 'Asian Session Open';
      isTransitionActive = true;
    }

    // Calculate time until next session
    let minutesUntilNextSession = 0;
    let nextSessionName = 'London Open (07:00 UTC)';

    if (currentMinOfDay < londonOpenMin) {
      minutesUntilNextSession = londonOpenMin - currentMinOfDay;
      nextSessionName = 'London Open (07:00 UTC)';
    } else if (currentMinOfDay < nyOpenMin) {
      minutesUntilNextSession = nyOpenMin - currentMinOfDay;
      nextSessionName = 'New York Open (13:00 UTC)';
    } else {
      minutesUntilNextSession = (24 * 60 - currentMinOfDay) + asianOpenMin;
      nextSessionName = 'Asian Open (00:00 UTC)';
    }

    return {
      session,
      name,
      utcTimeWindow,
      isTransitionActive,
      minutesUntilNextSession,
      nextSessionName,
    };
  }
}
