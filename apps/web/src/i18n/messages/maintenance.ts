import type { Translated } from '@pupitre/core';

/**
 * Les fenêtres de maintenance : leur écran, leur tiroir, leur formulaire, la
 * bande de la vue d'ensemble et les marques posées sur les cibles et les
 * sondes couvertes.
 */
const fr = {
  'meta.title': 'Maintenances',
  'page.title': 'Maintenances',
  'page.description':
    'Pendant une fenêtre, les alertes de supervision de ses cibles et de ses sondes sont retenues ; le journal, lui, garde tout. Ce qui est encore en panne à la fin part à ce moment-là.',
  'action.new': 'Planifier une maintenance',
  'empty.title': 'Aucune maintenance',
  'empty.hint':
    "Planifiez une fenêtre avant d'intervenir sur une machine : l'astreinte ne sera pas réveillée pour une panne voulue.",

  'section.active': 'En cours',
  'section.upcoming': 'À venir',
  'section.ended': 'Terminées',
  'phase.active': 'en cours',
  'phase.upcoming': 'à venir',
  'phase.ended': 'terminée',

  'row.open': 'Ouvrir la maintenance « {title} »',
  'row.until': "jusqu'à {time}",
  'row.from': 'à partir du {date}',
  'row.ended': 'terminée le {date}',
  'row.held': {
    zero: 'aucune alerte retenue',
    one: '{count} alerte retenue',
    other: '{count} alertes retenues',
  },
  'row.released': { one: '{count} partie à la fin', other: '{count} parties à la fin' },
  'row.hidden': { one: '+ {count} sujet masqué', other: '+ {count} sujets masqués' },

  'drawer.kind': 'Maintenance',
  'drawer.period': 'Période',
  'drawer.starts': 'Début',
  'drawer.ends': 'Fin',
  'drawer.duration': 'Durée',
  'duration.lessThanMinute': "moins d'une minute",
  'duration.minutes': '{minutes} min',
  'duration.hours': '{hours} h',
  'duration.hoursMinutes': '{hours} h {minutes}',
  'duration.days': '{days} j',
  'duration.daysHours': '{days} j {hours} h',
  'drawer.covers': 'Couvre',
  'drawer.covers.targets': 'Cibles',
  'drawer.covers.monitors': 'Sondes',
  'drawer.covers.derived':
    'Et, sur ces cibles, les sondes des applications qui y tournent ainsi que leurs domaines.',
  'drawer.covers.hidden': {
    one: '{count} sujet que vous ne pouvez pas lire.',
    other: '{count} sujets que vous ne pouvez pas lire.',
  },
  'drawer.note': 'Note',
  'drawer.held': 'Alertes retenues',
  'drawer.held.explain':
    'À la fin, pour chaque sujet, la dernière alerte part si elle signale une panne : une panne réparée pendant la fenêtre ne réveille personne.',
  'drawer.held.none': 'Aucune alerte retenue.',
  'drawer.held.loading': 'Lecture des alertes retenues…',
  'drawer.held.unreadable': 'Les alertes retenues sont illisibles pour le moment.',
  'drawer.held.state.held': 'retenue',
  'drawer.held.state.released': 'envoyée à la fin',
  'drawer.held.state.dropped': 'non envoyée',

  'action.edit': 'Modifier',
  'action.end': 'Terminer maintenant',
  'action.delete': 'Supprimer',
  'action.schedule': 'Mettre en maintenance',

  'confirm.end.title': 'Terminer « {title} » maintenant ?',
  'confirm.end.consequence.alerts': 'Les alertes de ses cibles et de ses sondes reprennent.',
  'confirm.end.consequence.release': 'Ce qui est encore en panne part dans la minute.',
  'confirm.end.action': 'Terminer',
  'confirm.delete.title': 'Supprimer « {title} » ?',
  'confirm.delete.upcoming': "La fenêtre n'a pas commencé : aucune alerte ne sera retenue.",
  'confirm.delete.ended':
    "L'historique de la fenêtre et de ses alertes retenues disparaît de cet écran. Le journal, lui, le garde.",
  'confirm.delete.action': 'Supprimer',

  'toast.created': '« {title} » planifiée',
  'toast.updated': '« {title} » modifiée',
  'toast.ended': '« {title} » terminée',
  'toast.ended.detail': 'Ce qui est encore en panne part dans la minute.',
  'toast.deleted': '« {title} » supprimée',

  'form.title.new': 'Planifier une maintenance',
  'form.title.edit': 'Modifier la maintenance',
  'form.field.title': 'Titre',
  'form.field.title.placeholder': 'Mise à jour du noyau',
  'form.field.starts': 'Début',
  'form.field.ends': 'Fin',
  'form.timezone': "Heures dans le fuseau de l'instance : {zone}.",
  'form.now': 'Maintenant',
  'form.durations': 'Durée',
  'form.field.targets': 'Cibles',
  'form.field.monitors': 'Sondes',
  'form.field.monitors.help':
    "Une sonde d'une application qui tourne sur une cible choisie est couverte d'office.",
  'form.filter': 'Filtrer…',
  'form.none.targets': 'Aucune cible.',
  'form.none.monitors': 'Aucune sonde.',
  'form.selected': { zero: 'aucune', one: '{count} choisie', other: '{count} choisies' },
  'form.field.note': 'Note',
  'form.field.note.help': "Pour l'équipe : ce qui se passe, qui intervient.",
  'form.submit.new': 'Planifier',
  'form.submit.edit': 'Enregistrer',
  'form.cancel': 'Annuler',
  'form.error.subjects': 'Choisissez au moins une cible ou une sonde.',
  'form.error.dates': 'La fin doit suivre le début.',
  'form.error.unreadable': 'Date illisible.',

  'banner.active': { one: 'Maintenance en cours', other: '{count} maintenances en cours' },
  'banner.upcomingOnly': { one: 'Maintenance prévue', other: '{count} maintenances prévues' },
  'banner.until': "« {title} » jusqu'à {time}",
  'banner.upcoming': '« {title} » prévue le {date}',
  'banner.open': 'Voir',
  'banner.aside': 'Les alertes de ces sujets sont retenues.',

  'mark.callout':
    "En maintenance jusqu'à {time} — « {title} ». Ses alertes de supervision sont retenues ; ce qui sera encore en panne à la fin partira à ce moment-là.",

  'error.notFound': "Cette fenêtre de maintenance n'existe pas, ou plus.",
  'error.ended':
    'Cette fenêtre est terminée : sa fin a été traitée, elle ne se modifie plus. Planifiez-en une autre.',
  'error.active':
    'Cette fenêtre est en cours : la supprimer ferait disparaître ses alertes retenues. Terminez-la plutôt.',
  'error.targetsForbidden': 'Choisir des cibles demande de pouvoir les lire.',
  'error.monitorsForbidden': 'Choisir des sondes demande de pouvoir les lire.',
  'error.targetNotFound': "La cible {id} n'existe pas.",
  'error.monitorNotFound': "La sonde {id} n'existe pas.",
};

const en: Translated<typeof fr> = {
  'meta.title': 'Maintenance',
  'page.title': 'Maintenance',
  'page.description':
    'During a window, monitoring alerts for its targets and probes are held; the audit log still keeps everything. Whatever is still down at the end is sent then.',
  'action.new': 'Schedule maintenance',
  'empty.title': 'No maintenance',
  'empty.hint':
    'Schedule a window before working on a machine: on-call will not be woken up for a deliberate outage.',

  'section.active': 'In progress',
  'section.upcoming': 'Upcoming',
  'section.ended': 'Ended',
  'phase.active': 'in progress',
  'phase.upcoming': 'upcoming',
  'phase.ended': 'ended',

  'row.open': 'Open maintenance “{title}”',
  'row.until': 'until {time}',
  'row.from': 'from {date}',
  'row.ended': 'ended {date}',
  'row.held': { zero: 'no alert held', one: '{count} alert held', other: '{count} alerts held' },
  'row.released': { one: '{count} sent at the end', other: '{count} sent at the end' },
  'row.hidden': { one: '+ {count} hidden subject', other: '+ {count} hidden subjects' },

  'drawer.kind': 'Maintenance',
  'drawer.period': 'Period',
  'drawer.starts': 'Start',
  'drawer.ends': 'End',
  'drawer.duration': 'Duration',
  'duration.lessThanMinute': 'less than a minute',
  'duration.minutes': '{minutes} min',
  'duration.hours': '{hours} h',
  'duration.hoursMinutes': '{hours} h {minutes}',
  'duration.days': '{days} d',
  'duration.daysHours': '{days} d {hours} h',
  'drawer.covers': 'Covers',
  'drawer.covers.targets': 'Targets',
  'drawer.covers.monitors': 'Probes',
  'drawer.covers.derived':
    'And, on these targets, the probes of the applications running there and their domains.',
  'drawer.covers.hidden': {
    one: '{count} subject you cannot read.',
    other: '{count} subjects you cannot read.',
  },
  'drawer.note': 'Note',
  'drawer.held': 'Alerts held',
  'drawer.held.explain':
    'At the end, for each subject, the last alert is sent if it reports an outage: an outage fixed during the window wakes no one.',
  'drawer.held.none': 'No alert held.',
  'drawer.held.loading': 'Reading held alerts…',
  'drawer.held.unreadable': 'Held alerts cannot be read right now.',
  'drawer.held.state.held': 'held',
  'drawer.held.state.released': 'sent at the end',
  'drawer.held.state.dropped': 'not sent',

  'action.edit': 'Edit',
  'action.end': 'End now',
  'action.delete': 'Delete',
  'action.schedule': 'Put in maintenance',

  'confirm.end.title': 'End “{title}” now?',
  'confirm.end.consequence.alerts': 'Alerts for its targets and probes resume.',
  'confirm.end.consequence.release': 'Whatever is still down is sent within a minute.',
  'confirm.end.action': 'End',
  'confirm.delete.title': 'Delete “{title}”?',
  'confirm.delete.upcoming': 'The window has not started: no alert will be held.',
  'confirm.delete.ended':
    'The history of the window and its held alerts leaves this screen. The audit log keeps it.',
  'confirm.delete.action': 'Delete',

  'toast.created': '“{title}” scheduled',
  'toast.updated': '“{title}” updated',
  'toast.ended': '“{title}” ended',
  'toast.ended.detail': 'Whatever is still down is sent within a minute.',
  'toast.deleted': '“{title}” deleted',

  'form.title.new': 'Schedule maintenance',
  'form.title.edit': 'Edit maintenance',
  'form.field.title': 'Title',
  'form.field.title.placeholder': 'Kernel update',
  'form.field.starts': 'Start',
  'form.field.ends': 'End',
  'form.timezone': 'Times in the instance time zone: {zone}.',
  'form.now': 'Now',
  'form.durations': 'Duration',
  'form.field.targets': 'Targets',
  'form.field.monitors': 'Probes',
  'form.field.monitors.help':
    'A probe of an application running on a chosen target is covered automatically.',
  'form.filter': 'Filter…',
  'form.none.targets': 'No target.',
  'form.none.monitors': 'No probe.',
  'form.selected': { zero: 'none', one: '{count} chosen', other: '{count} chosen' },
  'form.field.note': 'Note',
  'form.field.note.help': 'For the team: what is happening, who is on it.',
  'form.submit.new': 'Schedule',
  'form.submit.edit': 'Save',
  'form.cancel': 'Cancel',
  'form.error.subjects': 'Choose at least one target or probe.',
  'form.error.dates': 'The end must come after the start.',
  'form.error.unreadable': 'Unreadable date.',

  'banner.active': {
    one: 'Maintenance in progress',
    other: '{count} maintenance windows in progress',
  },
  'banner.upcomingOnly': {
    one: 'Maintenance scheduled',
    other: '{count} maintenance windows scheduled',
  },
  'banner.until': '“{title}” until {time}',
  'banner.upcoming': '“{title}” scheduled for {date}',
  'banner.open': 'View',
  'banner.aside': 'Alerts for these subjects are held.',

  'mark.callout':
    'In maintenance until {time} — “{title}”. Its monitoring alerts are held; whatever is still down at the end will be sent then.',

  'error.notFound': 'This maintenance window does not exist, or no longer does.',
  'error.ended':
    'This window has ended: its end was processed, it can no longer be changed. Schedule another one.',
  'error.active':
    'This window is in progress: deleting it would discard its held alerts. End it instead.',
  'error.targetsForbidden': 'Choosing targets requires being able to read them.',
  'error.monitorsForbidden': 'Choosing probes requires being able to read them.',
  'error.targetNotFound': 'Target {id} does not exist.',
  'error.monitorNotFound': 'Probe {id} does not exist.',
};

export const maintenance = { fr, en };
