// Minimal working example exercising every primary component of cc-webreport.
// Copy this file as a starting point for new reports.
const R = require('./report');

const overview = [
  R.Eyebrow('Section 01 · Overview'),
  R.H1('Q3 Status Report'),
  R.P('This quarter we shipped the automated showings pipeline and closed out the DoorLoop sync work. Below is a summary of what changed, what is left, and what needs a decision from you.'),
  R.card(
    R.checkList([
      'Automated showings intake live in production',
      'DoorLoop two-way sync shipped and monitored for 3 weeks with zero data-loss incidents',
      'Client dashboard redesign approved and in build',
    ]),
    { accent: 'green', bg: 'cardBg' }
  ),
].join('\n');

const details = [
  R.Eyebrow('Section 02 · Project Details', 'primary'),
  R.H1('Project Details'),
  R.H2('Environment'),
  R.specTable([
    ['Production URL', 'dashboard.rentingfreedom.com'],
    ['Vercel Team', 'renting-freedom'],
    ['Repo', 'github.com/rentingfreedom/dashboard'],
  ]),
  R.H2('Open Items'),
  R.twoColTable('Item', 'Status', [
    ['Vercel project relink', 'Blocked — needs client login'],
    ['Showings QA pass', 'In progress'],
    ['Phase 2 proposal sign-off', 'Awaiting client'],
  ]),
  R.H3('Notes'),
  R.P('The .vercel/project.json in the repo is stale and still points at the pre-handoff project. Production deploys need to be triggered manually from the client\'s Vercel login until this is resolved.'),
  R.bulletList([
    'No action needed from the client this week',
    'Will flag again once relink is unblocked',
  ]),
].join('\n');

const closing = [R.contactCard('Questions about this report?')].join('\n');

const html = R.buildReport({
  title: 'Renting Freedom — Q3 Status Report',
  cover: {
    eyebrow: 'Status Report',
    title: 'Q3 2026 Review',
    preparedFor: 'Renting Freedom LLC',
  },
  sections: [
    { id: 'overview', html: overview },
    { id: 'details', html: details },
    { id: 'contact', html: closing },
  ],
});

require('fs').writeFileSync(__dirname + '/sample.html', html, 'utf8');
console.log('Wrote sample.html');
