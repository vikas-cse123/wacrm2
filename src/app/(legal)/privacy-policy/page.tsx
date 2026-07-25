import type { Metadata } from "next";
import Link from "next/link";
import {
  LegalHeading,
  LegalList,
  LegalMeta,
  LegalSection,
} from "../_components/legal-content";
import {
  COMPANY_NAME,
  EFFECTIVE_DATE,
  PRODUCT_NAME,
  SUPPORT_EMAIL,
  WEBSITE_DOMAIN,
} from "../_constants";

export const metadata: Metadata = {
  title: "Privacy Policy | Interscale WhatsApp CRM",
  description:
    "How Interscale WhatsApp CRM collects, uses, protects and shares personal information, including data accessed through Google APIs.",
};

export default function PrivacyPolicyPage() {
  return (
    <article>
      <LegalHeading>Privacy Policy</LegalHeading>
      <LegalMeta>
        {PRODUCT_NAME} &middot; Effective date: {EFFECTIVE_DATE}
      </LegalMeta>

      <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
        This Privacy Policy explains how {COMPANY_NAME}{" "}(&ldquo;we,&rdquo;
        &ldquo;us,&rdquo; or &ldquo;our&rdquo;) collects, uses, stores, shares
        and protects information in connection with {PRODUCT_NAME}{" "}(the
        &ldquo;Service&rdquo;), available at {WEBSITE_DOMAIN}. By creating an
        account or using the Service, you agree to the practices described in
        this policy.
      </p>

      <LegalSection id="information-we-collect" title="1. Information We Collect">
        <p>
          We collect the following categories of information so that we can
          provide, secure and improve the Service:
        </p>
      </LegalSection>

      <LegalSection
        id="account-contact-information"
        title="2. Account and Contact Information"
      >
        <p>
          When you register for or use the Service, we collect information you
          provide directly, such as:
        </p>
        <LegalList>
          <li>Your name, email address and password credentials.</li>
          <li>
            Your organisation or team name and the details of team members you
            invite.
          </li>
          <li>
            Profile and workspace settings, including appearance and
            notification preferences.
          </li>
          <li>
            Billing and subscription contact details, where applicable, used to
            administer your plan.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection
        id="crm-records"
        title="3. CRM Contacts, Conversations and Business Records"
      >
        <p>
          The Service is a customer relationship management (CRM) tool. To
          provide it, we process the business data you and your team create,
          import or receive, including:
        </p>
        <LegalList>
          <li>
            Contact records such as customer names, phone numbers, tags, notes
            and custom fields.
          </li>
          <li>
            WhatsApp and other messaging conversations, message content,
            attachments and delivery status.
          </li>
          <li>
            Pipelines, deals, broadcasts, automations and other business
            records you manage in the Service.
          </li>
        </LegalList>
        <p>
          This data belongs to you and your organisation. We process it on your
          behalf to operate the Service.
        </p>
      </LegalSection>

      <LegalSection
        id="google-account-information"
        title="4. Google Account Information"
      >
        <p>
          If you connect a Google account, we access limited account
          information, such as your Google account email address, to identify
          the connected account and maintain the Google Sheets integration for
          your {PRODUCT_NAME} workspace.
        </p>
        <p>
          We do not access Gmail, Google Calendar, Google Contacts, Google
          Photos, or other unrelated Google services.
        </p>
      </LegalSection>

      <LegalSection
        id="google-sheets-data"
        title="5. Google Sheets Data Accessed Through OAuth"
      >
        <p>
          When you authorise the Google Sheets integration, the Service may
          access Google Sheets data only as required to provide the spreadsheet
          synchronisation feature.
        </p>
        <p>Depending on the actions you choose, the Service may:</p>
        <LegalList>
          <li>identify spreadsheets available to the connected Google account;</li>
          <li>access a spreadsheet that you select;</li>
          <li>create a new spreadsheet when you request it;</li>
          <li>read the linked spreadsheet&rsquo;s structure and column headings;</li>
          <li>append collected CRM automation-flow responses as new rows;</li>
          <li>
            import previously completed responses into the linked spreadsheet
            when you explicitly request it; and
          </li>
          <li>replace or unlink the currently connected spreadsheet.</li>
        </LegalList>
        <p>
          The Service does not access Google Sheets for advertising, profiling,
          credit assessment or unrelated purposes.
        </p>
      </LegalSection>

      <LegalSection
        id="oauth-tokens"
        title="6. OAuth Access Tokens and Refresh Tokens"
      >
        <p>
          To keep your Google integration working without repeatedly asking you
          to sign in, we receive and store OAuth access tokens and refresh
          tokens issued by Google. These tokens authorise the Service to call
          Google APIs on your behalf within the scope you granted. They are
          stored in encrypted form and are used only to provide the features
          you enabled. You can revoke them at any time (see
          {" "}
          <Link
            href="#disconnect-google"
            className="text-primary hover:text-primary/80"
          >
            Disconnecting Your Google Account
          </Link>
          ).
        </p>
      </LegalSection>

      <LegalSection
        id="why-sheets-access"
        title="7. Why Google Sheets Access Is Required"
      >
        <p>
          Google Sheets access is required only to synchronise responses
          collected through CRM automation flows.
        </p>
        <p>
          When a contact reaches a Google Sheets Sync node in a flow, the
          Service appends the collected response data as a new row in the
          spreadsheet selected by the authorised user.
        </p>
        <p>
          The integration may also allow an authorised user to create a new
          spreadsheet, replace the linked spreadsheet, or import previously
          completed flow responses.
        </p>
        <p>
          If you do not connect Google Sheets, the spreadsheet synchronisation
          feature will not operate, but other CRM features may continue to work.
        </p>
      </LegalSection>

      <LegalSection
        id="how-sheets-data-used"
        title="8. How Google Sheets Data Is Used"
      >
        <p>
          Google Sheets data is used only to provide the spreadsheet
          synchronisation functionality initiated and configured by the
          authorised user.
        </p>
        <p>
          The Service may write collected flow-response information to the
          selected spreadsheet. This information may include fields configured
          in the flow, such as phone number, flow name, submission time, user
          ID, answers, traveller details, destination preferences or other
          fields selected by the workspace user.
        </p>
        <p>We do not use Google Sheets data:</p>
        <LegalList>
          <li>for advertising or marketing profiling;</li>
          <li>
            to train general-purpose artificial intelligence or machine-learning
            models;
          </li>
          <li>to determine creditworthiness or for lending purposes;</li>
          <li>for purposes unrelated to the spreadsheet integration; or</li>
          <li>for sale to third parties.</li>
        </LegalList>
      </LegalSection>

      <LegalSection
        id="data-storage"
        title="9. Whether Google Data Is Stored"
      >
        <p>
          We store the minimum Google-related information necessary to operate
          the integration.
        </p>
        <p>This may include:</p>
        <LegalList>
          <li>the connected Google account email address;</li>
          <li>encrypted OAuth access and refresh tokens;</li>
          <li>identifiers for the linked spreadsheet and sheet;</li>
          <li>
            integration configuration, such as selected columns and flow
            mappings; and
          </li>
          <li>
            technical logs required for security, error diagnosis and
            synchronisation status.
          </li>
        </LegalList>
        <p>
          The underlying CRM flow responses may already be stored within the
          user&rsquo;s CRM workspace as part of the normal operation of the
          Service. The Google Sheets integration sends those responses to the
          spreadsheet selected by the user.
        </p>
        <p>
          We do not create or retain a separate copy of the user&rsquo;s entire
          Google Spreadsheet unless technically necessary to perform an action
          requested by the user.
        </p>
      </LegalSection>

      <LegalSection id="how-we-protect" title="10. How Data Is Protected">
        <p>
          We apply administrative, technical and physical safeguards designed to
          protect your information, including:
        </p>
        <LegalList>
          <li>Encryption of data in transit using TLS.</li>
          <li>Encryption of sensitive data such as OAuth tokens at rest.</li>
          <li>
            Access controls that limit data access to authorised personnel and
            processes.
          </li>
          <li>
            Authentication, session management and infrastructure hardening for
            the application.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection
        id="third-party-sharing"
        title="11. Whether Data Is Shared With Third Parties"
      >
        <p>
          We do not sell your data. We share information only as needed to run
          the Service:
        </p>
        <LegalList>
          <li>
            With infrastructure and sub-processors (for example, hosting,
            database, and messaging providers) that process data on our behalf
            under appropriate confidentiality and data-protection obligations.
          </li>
          <li>
            With integrations you explicitly connect, such as WhatsApp and
            Google, to deliver the features you request.
          </li>
          <li>
            Where required by law, regulation, legal process, or to protect the
            rights, safety and security of users and the public.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection
        id="no-sale-of-google-data"
        title="12. Google User Data Is Not Sold"
      >
        <p>
          We do not sell, rent or trade Google user data. Google user data is
          used exclusively to provide and improve the specific user-facing
          features you enable within {PRODUCT_NAME}.
        </p>
      </LegalSection>

      <LegalSection
        id="google-api-services-user-data"
        title="13. Google API Services User Data"
      >
        <p>
          {PRODUCT_NAME}&rsquo;s use and transfer of information received from
          Google APIs will adhere to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
        <p>
          In accordance with the Limited Use requirements, information obtained
          from Google APIs is used only to provide or improve user-facing
          features that are prominent in the Service; is not transferred to
          others except as necessary to provide or improve those features, to
          comply with applicable law, or as part of a merger, acquisition or
          sale of assets with user notice and consent; is not used or
          transferred for serving advertising; and is not used or transferred to
          determine credit-worthiness or for lending purposes. Humans do not
          read Google user data unless we have your affirmative consent for
          specific messages, it is necessary for security purposes (such as
          investigating abuse), to comply with applicable law, or the data has
          been aggregated and anonymised for internal operations.
        </p>
      </LegalSection>

      <LegalSection
        id="disconnect-google"
        title="14. How to Disconnect Your Google Account"
      >
        <p>
          You may disconnect Google Sheets from within the relevant integration
          or flow settings in the Service.
        </p>
        <p>After disconnection:</p>
        <LegalList>
          <li>
            the Service will stop making new Google Sheets API requests for that
            integration;
          </li>
          <li>
            stored OAuth credentials associated with the connection will be
            deleted or invalidated;
          </li>
          <li>automatic synchronisation of new flow responses will stop; and</li>
          <li>
            data already written to the user&rsquo;s Google Spreadsheet will
            remain in that spreadsheet unless the user deletes it directly.
          </li>
        </LegalList>
        <p>
          You may also revoke access through your{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80"
          >
            Google Account permissions page
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection
        id="data-deletion"
        title="15. How to Request Deletion of Your Data"
      >
        <p>
          You may request deletion of your account and associated data by
          emailing us at{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-primary hover:text-primary/80"
          >
            {SUPPORT_EMAIL}
          </a>
          . On a verified request, we will delete or anonymise your personal
          data and any stored Google user data, except where retention is
          required by law. Disconnecting your Google account (Section 14)
          immediately removes stored Google OAuth tokens.
        </p>
      </LegalSection>

      <LegalSection id="data-retention" title="16. Data Retention">
        <p>
          We retain personal and business data for as long as your account is
          active or as needed to provide the Service, and thereafter only as
          required to comply with legal obligations, resolve disputes and
          enforce our agreements. Google-related data is retained only while the
          integration remains connected: when you disconnect the integration or
          request deletion (Sections 14 and 15), the associated OAuth
          credentials are deleted or invalidated. Data you have written to your
          own Google Spreadsheet remains under your control in that spreadsheet.
        </p>
      </LegalSection>

      <LegalSection id="cookies-analytics" title="17. Cookies and Analytics">
        <p>
          We use strictly necessary cookies to keep you signed in and to secure
          your session. We may also use limited analytics to understand how the
          Service is used and to improve it. Any such analytics does not use
          Google user data, and Google user data is never used for advertising.
        </p>
      </LegalSection>

      <LegalSection id="security-limitations" title="18. Security Limitations">
        <p>
          No method of transmission or storage is completely secure. While we
          work hard to protect your information, we cannot guarantee absolute
          security, and you use the Service at your own risk. Please keep your
          account credentials confidential and notify us promptly of any
          suspected unauthorised access.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="19. Changes to This Policy">
        <p>
          We may update this Privacy Policy from time to time. When we make
          material changes, we will revise the effective date above and, where
          appropriate, provide additional notice. Your continued use of the
          Service after changes take effect constitutes acceptance of the
          updated policy.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="20. Contact Details">
        <p>
          If you have questions about this Privacy Policy or our data practices,
          contact us at{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-primary hover:text-primary/80"
          >
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
        <p>
          {COMPANY_NAME} &middot;{" "}
          <a
            href={WEBSITE_DOMAIN}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80"
          >
            {WEBSITE_DOMAIN}
          </a>
        </p>
      </LegalSection>
    </article>
  );
}
