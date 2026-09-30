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
 * Le catalogue : les modèles, rendus une fois ici en AppSpec d'aperçu pour
 * que l'écran montre exactement ce qui va tourner — les mêmes lignes que la
 * fiche d'une application. L'installation, elle, repasse par le serveur :
 * c'est lui qui rend la spec définitive, avec le nom et le domaine choisis.
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
