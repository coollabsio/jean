export interface SentryProject {
  id: string
  name: string
  slug: string
}

export interface SentryOrganization {
  id: string
  name: string
  slug: string
}

export interface SentryProjectMapping extends SentryProject {
  organization: SentryOrganization
}

export interface SentryIssue {
  id: string
  shortId: string
  title: string
  culprit: string
  permalink: string
  level: string
  status: string
  count: string
  userCount: number
  firstSeen: string
  lastSeen: string
  project: SentryProject
}

export interface SentryIssueContext {
  id: string
  shortId: string
  title: string
  permalink: string
  content: string
}
