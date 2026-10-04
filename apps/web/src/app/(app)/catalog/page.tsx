import {
  CATALOG_CATEGORIES,
  CATALOG_TEMPLATES,
  instantiateCatalogTemplate,
  storedSecretNames,
} from '@pupitre/core';
import { listApplications } from '@pupitre/db';
import { currentLanguage } from '@/i18n/server';
import { requirePagePermission } from '@/lib/page-auth';
import { serviceRows } from '../applications/rows';
import { CatalogView, type TemplateView } from './catalog-view';

export const dynamic = 'force-dynamic';

/**
 * The catalog: the templates, rendered once here into a preview AppSpec so that
 * the screen shows exactly what will run — the same rows as an application's
 * record. The installation, for its part, goes through the server again: it is
 * the server that renders the final spec, with the chosen name and domain.
 */
export default async function CatalogPage() {
  const auth = await requirePagePermission('/catalog', 'application:create');
  const language = await currentLanguage();
  const applications = await listApplications();

  const templates: TemplateView[] = CATALOG_TEMPLATES.map((template) => {
    const spec = instantiateCatalogTemplate(template, {
      name: template.id,
      host: null,
      tls: false,
      email: auth.email,
    });
    return {
      id: template.id,
      name: template.name,
      category: template.category,
      website: template.website,
      summary: template.summary[language],
      firstRun: template.firstRun[language],
      askedSecrets: [...template.askedSecrets],
      generatedSecrets: storedSecretNames(spec).filter(
        (name) => !template.askedSecrets.includes(name),
      ).length,
      wantsHost: template.wantsHost,
      services: serviceRows(spec),
      images: spec.services.flatMap((service) =>
        service.source.type === 'image' ? [service.source.ref] : [],
      ),
    };
  });

  return (
    <CatalogView
      templates={templates}
      categories={[...CATALOG_CATEGORIES]}
      taken={applications.map((application) => application.slug)}
    />
  );
}
