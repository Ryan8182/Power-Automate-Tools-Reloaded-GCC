import { Actions } from "./common/types/backgroundActions";
import jwtDecode from "jwt-decode";

interface State {
  token?: string;
  url?: URL;
  initiatorTabId?: number;
  appTabId?: number;
  apiUrl?: string;
  tokenExpires?: Date;
  lastMatchedRequest?: { envId: string; flowId: string } | null;
}

const state: State = {};

// Enable debugging - can be disabled in production
const DEBUG = true;

function debugLog(...args: any[]) {
  if (DEBUG) {
    console.log('[PA-Tools Background]', ...args);
  }
}

function debugError(...args: any[]) {
  if (DEBUG) {
    console.error('[PA-Tools Background Error]', ...args);
  }
}

// Start with extension enabled so users can always try to click it
chrome.action.enable();
debugLog('Extension initialized, action enabled');

chrome.action.onClicked.addListener((tab) => {
  debugLog('Extension clicked, current state:', {
    hasLastMatchedRequest: !!state.lastMatchedRequest,
    hasToken: !!state.token,
    tokenExpired: isTokenExpired(),
    currentTabUrl: tab.url
  });

  // If we don't have a matched request, try to extract from current tab URL
  if (!state.lastMatchedRequest && tab.url) {
    debugLog('No matched request found, trying to extract from current tab URL');
    state.lastMatchedRequest = extractFlowDataFromTabUrl(tab.url);
    if (state.lastMatchedRequest) {
      state.initiatorTabId = tab.id;
      debugLog('Flow data extracted from current tab:', state.lastMatchedRequest);
    }
  }

  if (!state.lastMatchedRequest) {
    debugError('No flow data found. Make sure you are on a Power Automate flow page.');
    debugLog('Current URL being analyzed:', tab.url);
    
    // Show a more detailed notification with the URL for debugging
    const urlInfo = tab.url ? ` Current URL: ${tab.url.substring(0, 100)}${tab.url.length > 100 ? '...' : ''}` : '';
    showNotification(`Please navigate to a Power Automate flow page first.${urlInfo ? ' Check console for URL details.' : ''}`);
    
    // Also log detailed URL analysis
    if (tab.url) {
      debugLog('URL Analysis:');
      debugLog('- Full URL:', tab.url);
      debugLog('- Contains "flow":', tab.url.includes('flow'));
      debugLog('- Contains "powerautomate":', tab.url.includes('powerautomate'));
      debugLog('- Contains "make.":', tab.url.includes('make.'));
      debugLog('- Contains environment pattern:', /environment/i.test(tab.url));
      debugLog('- Contains GUID pattern:', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(tab.url));
    }
    
    return;
  }

  // If we have flow data but no token, show helpful message
  if (!state.token) {
    debugError('No authentication token found');
    showNotification('No authentication detected. Please refresh the Power Automate page and interact with the flow (click edit, details, etc.) then try again.');
    return;
  }

  if (isTokenExpired()) {
    debugError('Token expired, requesting refresh');
    showNotification('Token expired. Please refresh the Power Automate page and try again.');
    return;
  }

  const appUrl = `${chrome.runtime.getURL("app.html")}?envId=${
    state.lastMatchedRequest.envId
  }&flowId=${state.lastMatchedRequest.flowId}`;
  
  debugLog('Creating app tab with URL:', appUrl);

  chrome.tabs.create(
    {
      url: appUrl,
    },
    (appTab) => {
      if (chrome.runtime.lastError) {
        debugError('Failed to create app tab:', chrome.runtime.lastError);
        showNotification('Failed to open extension. Please try again.');
        return;
      }
      state.appTabId = appTab.id;
      debugLog('App tab created with ID:', appTab.id);
    }
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.appTabId === tabId) {
    debugLog('App tab closed:', tabId);
    delete state.appTabId;
  }
});

// Listen to multiple API endpoints for better coverage
chrome.webRequest.onBeforeSendHeaders.addListener(
  listenFlowApiRequests,
  {
    urls: [
      "https://make.gov.powerautomate.us/*",
      "https://*.api.crm9.dynamics.com/*",
      "https://*.api.flow.microsoft.com/*",
      "https://*.api.powerautomate.com/*",
      "https://*.api.powerapps.com/*",
      "https://unitedstates.api.powerapps.com/*",
      "https://europe.api.powerapps.com/*",
      "https://asia.api.powerapps.com/*",
      "https://australia.api.powerapps.com/*",
      "https://india.api.powerapps.com/*",
      "https://japan.api.powerapps.com/*",
      "https://canada.api.powerapps.com/*",
      "https://southamerica.api.powerapps.com/*",
      "https://unitedkingdom.api.powerapps.com/*",
      "https://france.api.powerapps.com/*",
      "https://germany.api.powerapps.com/*",
      "https://switzerland.api.powerapps.com/*",
      "https://usgov.api.powerapps.us/*",
      "https://usgovhigh.api.powerapps.us/*",
      "https://dod.api.powerapps.us/*",
      "https://gov.api.powerapps.us/",
      "https://*.gov.api.flow.microsoft.us/*",
      "https://gov.api.flow.microsoft.us/*",
      "https://*.gov.api.powerautomate.us/*",
      "https://*.gov.api.powerapps.us/*",
      "https://gov.api.powerapps.us/*"
    ],
  },
  ["requestHeaders"]
);

chrome.runtime.onMessage.addListener(
  (action: Actions, sender, sendResponse) => {
    debugLog('Received message:', action.type, 'from tab:', sender.tab?.id);
    
    if (sender.tab?.id === state.appTabId) {
      switch (action.type) {
        default:
          sendResponse();
          break;
        case "app-loaded":
          debugLog('App loaded, sending token');
          sendResponse();
          sendTokenChanged();
          break;
        case "refresh":
          debugLog('Refresh requested');
          sendResponse();
          refreshInitiator();
          break;
      }
    } else {
      debugLog('Message from non-app tab, ignoring');
      sendResponse();
    }
  }
);

function isTokenExpired(): boolean {
  if (!state.tokenExpires) return true;
  // Add 5 minute buffer before expiration
  const bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds
  return new Date().getTime() > (state.tokenExpires.getTime() - bufferTime);
}

function showNotification(message: string) {
  chrome.notifications?.create({
    type: 'basic',
    iconUrl: 'icons/pa-tools-48.png',
    title: 'Power Automate Tools GCC Edition',
    message: message
  });
}

function sendTokenChanged() {
  if (!state.token || !state.apiUrl) {
    debugError('Cannot send token - missing token or apiUrl');
    return;
  }

  if (isTokenExpired()) {
    debugError('Token expired, not sending');
    showNotification('Authentication token expired. Please refresh the Power Automate page.');
    return;
  }

  debugLog('Sending token changed message');
  sendMessageToTab({
    type: "token-changed",
    token: state.token!,
    apiUrl: state.apiUrl!,
  });
}

function refreshInitiator() {
  if (state.initiatorTabId) {
    debugLog('Refreshing initiator tab:', state.initiatorTabId);
    chrome.tabs.reload(state.initiatorTabId, {}, () => {
      if (chrome.runtime.lastError) {
        debugError('Failed to refresh tab:', chrome.runtime.lastError);
      } else {
        debugLog('Tab refreshed successfully');
      }
    });
  } else {
    debugLog('No initiator tab to refresh');
  }
}

function listenFlowApiRequests(
  details: chrome.webRequest.WebRequestHeadersDetails
) {
  // Skip if this is from our own app tab
  if (state.appTabId === details.tabId) {
    return;
  }
  debugLog('Details:  ', details);
  debugLog('Intercepted API request:', details.url);
  
  state.lastMatchedRequest = extractFlowDataFromUrl(details);

  
  const authHeader = details.requestHeaders?.find(
    (x) => x.name.toLowerCase() === "authorization"
  );
  
  const token = authHeader?.value;

  if (!token) {
    debugLog('No authorization token found in request');
    return;
  }

  if (state.token !== token) {
    debugLog('New token detected, updating state');
    state.token = token;

    try {
      const decodedToken = jwtDecode(token!) as any;
      state.tokenExpires = new Date(decodedToken.exp * 1000);
      debugLog('Token expires at:', state.tokenExpires);

      const url = new URL(details.url);
      state.apiUrl = `${url.protocol}//${url.hostname}/`;
      debugLog('API URL set to:', state.apiUrl);

      sendTokenChanged();
    } catch (error) {
      debugError('Failed to decode token:', error);
      return;
    }
  }

  if (state.lastMatchedRequest) {
    debugLog('Flow data extracted:', state.lastMatchedRequest);
    state.initiatorTabId = details.tabId;
    chrome.action.enable();
    debugLog('Extension action enabled');
  } else {
    debugLog('No flow data found in URL, trying tab URL');
    tryExtractFlowDataFromTabUrl(details.tabId);
  }
}

function tryExtractFlowDataFromTabUrl(tabId: number) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) {
      debugError('Failed to get tab:', chrome.runtime.lastError);
      return;
    }

    debugLog('Checking tab URL for flow data:', tab.url);
    state.lastMatchedRequest = extractFlowDataFromTabUrl(tab.url);

    if (state.lastMatchedRequest) {
      debugLog('Flow data extracted from tab URL:', state.lastMatchedRequest);
      state.initiatorTabId = tabId;
      chrome.action.enable();
      debugLog('Extension action enabled from tab URL');
    } else {
      debugLog('No flow data found in tab URL');
    }
  });
}

function sendMessageToTab(action: Actions) {
  if (state.appTabId) {
    debugLog('Sending message to app tab:', action.type);
    chrome.tabs.sendMessage(state.appTabId!, action, (response) => {
      if (chrome.runtime.lastError) {
        debugError('Failed to send message to app tab:', chrome.runtime.lastError);
      } else {
        debugLog('Message sent successfully');
      }
    });
  } else {
    debugLog('No app tab to send message to');
  }
}

function extractFlowDataFromTabUrl(url?: string) {
  if (!url) {
    debugLog('No URL provided for extraction');
    return null;
  }

  debugLog('Extracting flow data from tab URL:', url);

  // Multiple patterns to handle different Power Automate URL formats
  const envPatterns = [
    // New Power Automate URLs
    /\/environments\/([a-zA-Z0-9\-]*)\//i,
    // Legacy URLs
    /environment\/([a-zA-Z0-9\-]*)\//i,
    // Alternative patterns
    /\/environment=([a-zA-Z0-9\-]*)/i,
    /envid=([a-zA-Z0-9\-]*)/i,
    // Query parameter patterns
    /[?&]environmentId=([a-zA-Z0-9\-]*)/i,
    /[?&]env=([a-zA-Z0-9\-]*)/i,
    // URL enco ded patterns
    /environments%2F([a-zA-Z0-9\-]*)/i,
  ];

  let envResult: RegExpExecArray | null = null;
  let matchedEnvPattern = '';
  
  for (let i = 0; i < envPatterns.length; i++) {
    const pattern = envPatterns[i];
    envResult = pattern.exec(url);
    if (envResult) {
      matchedEnvPattern = pattern.toString();
      debugLog(`Environment ID found with pattern ${i + 1}:`, matchedEnvPattern, '→', envResult[1]);
      break;
    }
  }

  if (!envResult) {
    debugLog('No environment ID found in URL. Tried patterns:', envPatterns.map(p => p.toString()));
    return null;
  }

  // Multiple flow ID patterns
  const flowPatterns = [
    // Standard GUID format
    /flows\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    // Shared flows format
    /flows\/shared\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    // URL encoded format
    /flows\/([0-9a-f]{8}%2D[0-9a-f]{4}%2D[0-9a-f]{4}%2D[0-9a-f]{4}%2D[0-9a-f]{12})/i,
    /flows\/shared\/([0-9a-f]{8}%2D[0-9a-f]{4}%2D[0-9a-f]{4}%2D[0-9a-f]{4}%2D[0-9a-f]{12})/i,
    // Alternative patterns
    /flow\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /flow\/shared\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /flowid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    // Query parameter patterns
    /[?&]flowId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /[?&]id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    // URL encoded patterns
    /flows%2F([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /flows%2Fshared%2F([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    // Hash-based patterns (for SPAs)
    /#.*flows\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /#.*flows\/shared\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  ];

  let flowResult: RegExpExecArray | null = null;
  let matchedFlowPattern = '';
  
  for (let i = 0; i < flowPatterns.length; i++) {
    const pattern = flowPatterns[i];
    flowResult = pattern.exec(url);
    if (flowResult) {
      matchedFlowPattern = pattern.toString();
      // Decode URL encoded GUIDs
      flowResult[1] = decodeURIComponent(flowResult[1]);
      debugLog(`Flow ID found with pattern ${i + 1}:`, matchedFlowPattern, '→', flowResult[1]);
      break;
    }
  }

  if (!flowResult) {
    debugLog('No flow ID found in URL. Tried patterns:', flowPatterns.map(p => p.toString()));
    return null;
  }

  const result = {
    envId: envResult[1],
    flowId: flowResult[1],
  };

  debugLog('Successfully extracted flow data:', result);
  return result;
}

function extractFlowDataFromUrl(
  details: chrome.webRequest.WebRequestHeadersDetails
) {
  const requestUrl = details.url;
  if (!requestUrl) {
    return null;
  }

  debugLog('Extracting flow data from API URL:', requestUrl);

  // Multiple patterns for different API endpoints
  const patterns = [
    // Standard pattern
    /\/providers\/Microsoft\.ProcessSimple\/environments\/(.*)\/flows\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    // Alternative pattern
    /\/environments\/(.*)\/flows\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  ];

  for (const pattern of patterns) {
    const result = pattern.exec(requestUrl);
    if (result) {
      const flowData = {
        envId: result[1],
        flowId: result[2],
      };
      debugLog('Extracted flow data from API URL:', flowData);
      return flowData;
    }
  }

  debugLog('No flow data found in API URL');
  return null;
}
