/**
 * FocusGuard Blocked Page Script
 * Displays when a blocked site is accessed. Shows motivational quotes,
 * tracks block statistics, and provides navigation options.
 */

// Pool of 25 motivational quotes about discipline, strength, and self-control
const quotes = [
  {
    text: 'The secret of getting ahead is getting started.',
    author: 'Mark Twain',
  },
  {
    text: 'Strength does not come from winning. Your struggles develop your strengths.',
    author: 'Arnold Schwarzenegger',
  },
  {
    text: 'It does not matter how slowly you go as long as you do not stop.',
    author: 'Confucius',
  },
  {
    text: 'The only person you are destined to become is the person you decide to be.',
    author: 'Ralph Waldo Emerson',
  },
  {
    text: 'Discipline is the bridge between goals and accomplishment.',
    author: 'Jim Rohn',
  },
  {
    text: 'We must all suffer one of two things: the pain of discipline or the pain of regret.',
    author: 'Jim Rohn',
  },
  {
    text: 'Motivation is what gets you started. Habit is what keeps you going.',
    author: 'Jim Ryun',
  },
  {
    text: 'The future depends on what you do today.',
    author: 'Mahatma Gandhi',
  },
  {
    text: "Don't stop when you're tired. Stop when you're done.",
    author: 'David Goggins',
  },
  {
    text: 'Self-control is the chief element in self-respect, and self-respect is the chief element in courage.',
    author: 'Thucydides',
  },
  {
    text: 'Success is the sum of small efforts, repeated day in and day out.',
    author: 'Robert Collier',
  },
  {
    text: 'The price of excellence is discipline. The cost of mediocrity is disappointment.',
    author: 'William Arthur Ward',
  },
  {
    text: 'You will never have this day again so make it count.',
    author: 'Unknown',
  },
  {
    text: "It's not about perfect. It's about effort. And when you bring that effort every single day, that's where transformation happens.",
    author: 'Jillian Michaels',
  },
  {
    text: 'Focus on your goals, not your fear.',
    author: 'Roy T. Bennett',
  },
  {
    text: 'The key to success is to focus our conscious mind on things we desire not things we fear.',
    author: 'Brian Tracy',
  },
  {
    text: 'Rule your mind or it will rule you.',
    author: 'Horace',
  },
  {
    text: 'Your future is created by what you do today, not tomorrow.',
    author: 'Robert Kiyosaki',
  },
  {
    text: 'Small disciplines repeated with consistency every day lead to great achievements gained slowly over time.',
    author: 'John C. Maxwell',
  },
  {
    text: 'First we make our habits, then our habits make us.',
    author: 'Charles C. Noble',
  },
  {
    text: 'A year from now you may wish you had started today.',
    author: 'Karen Lamb',
  },
  {
    text: 'The man who moves a mountain begins by carrying away small stones.',
    author: 'Confucius',
  },
  {
    text: 'Freedom is the only worthy goal in life. It is won by disregarding things that lie beyond our control.',
    author: 'Epictetus',
  },
  {
    text: 'No man is free who is not master of himself.',
    author: 'Epictetus',
  },
  {
    text: 'With self-discipline most anything is possible.',
    author: 'Theodore Roosevelt',
  },
];

document.addEventListener('DOMContentLoaded', () => {
  // 1. Parse URL parameters to get the blocked domain name
  const urlParams = new URLSearchParams(window.location.search);
  const domain = urlParams.get('domain');

  // Display the blocked domain
  const domainEl = document.getElementById('blocked-domain');
  if (domain && domainEl) {
    domainEl.textContent = domain;
  }

  // If redirected here from an old cached chrome://extensions intercept,
  // trigger a runtime reload so the extension updates immediately from disk
  if (domain && (domain.includes('chrome://extensions') || domain.includes('edge://extensions'))) {
    if (chrome?.runtime?.reload) {
      console.log('[FocusGuard] Flushing old cached intercept via chrome.runtime.reload()...');
      chrome.runtime.reload();
    }
  }

  // 2. Select and display a random motivational quote
  const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
  const quoteText = document.getElementById('quote-text');
  const quoteAuthor = document.getElementById('quote-author');
  if (quoteText) quoteText.textContent = randomQuote.text;
  if (quoteAuthor) quoteAuthor.textContent = `— ${randomQuote.author}`;

  // 3. Fetch stats from chrome.storage.local and display total blocked count
  if (chrome?.storage?.local) {
    chrome.storage.local.get(['stats'], (result) => {
      const stats = result.stats || {};
      const totalBlocked = stats.totalBlocked || 0;
      // Show count + 1 (this current block will be tracked)
      updateStatsUI(totalBlocked + 1);
    });

    // Listen for live storage updates
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && changes.stats) {
        const newStats = changes.stats.newValue || {};
        updateStatsUI(newStats.totalBlocked || 0);
      }
    });
  } else {
    updateStatsUI(1);
  }

  // 4. Send trackBlock message to background to increment counters
  if (chrome?.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ action: 'trackBlock', domain: domain });
  }

  // 5. "Go Back" button
  // Use history.go(-2) to skip past the blocked URL that triggered the redirect.
  // history.back() would go back to the blocked site → immediate re-redirect → infinite loop.
  const btnBack = document.getElementById('btn-back');
  if (btnBack) {
    btnBack.addEventListener('click', () => {
      if (window.history.length > 2) {
        window.history.go(-2);
      } else {
        // Not enough history to skip back — just go home
        window.location.href = 'https://www.google.com';
      }
    });
  }

  // 6. "Go Home" button — navigate current tab to new tab page
  const btnHome = document.getElementById('btn-home');
  if (btnHome) {
    btnHome.addEventListener('click', () => {
      // In an extension page context, we can use chrome.tabs
      // But blocked.html is loaded as a redirect, so we navigate directly
      window.location.href = 'https://www.google.com';
    });
  }

  // 7. Add fade-in animation class after a small delay
  const container = document.querySelector('.container');
  if (container) {
    requestAnimationFrame(() => {
      container.classList.add('visible');
    });
  }
});

/**
 * Update the stats counter in the UI.
 */
function updateStatsUI(count) {
  const statsCounter = document.getElementById('stats-counter');
  if (statsCounter) {
    statsCounter.textContent = `You've blocked ${count} attempt${count !== 1 ? 's' : ''} so far. Keep going!`;
  }
}
